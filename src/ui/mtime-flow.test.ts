/**
 * "真实修改时间"的端到端自测（假网络 + 内存文件层）。
 *
 * 验证最要紧的一件事：**反推出来的时间对不对**。这块逻辑绕（"前沿"的含义、中断后从哪
 * 继续），纯函数测试只能证明规则自洽，接上真实的 URL 形态才证明"接对了"。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { MANIFEST_FILE } from '@core/fs/layout';
import { FakeFetch } from '@core/net/fake-fetch';
import { deserializeMeta, effectiveMtime, hasRealMtime } from '@core/sync/manifest';
import {
  useNotes,
  __abortContentPullForTest,
  __awaitContentPullForTest,
  __awaitMtimeRefreshForTest,
  __setFetchForTest,
} from './store';

/** 造历史：C1 最新 … C4 最旧（日期递减），提交 C_i 改的是 `C_i.md`。 */
const COMMITS = Array.from({ length: 4 }, (_, i) => ({
  sha: `C${i + 1}`,
  date: new Date(Date.UTC(2026, 0, 10) - i * 86_400_000).toISOString(),
}));

/**
 * 假网络：树里有两篇笔记，历史里另有它们的改动记录。
 *
 * 路由顺序要紧（第一个命中的生效）：**blob 与树必须先于历史路由**，
 * 否则宽匹配会把它们一并吞掉。`/commits?`（列表）与 `/git/commits/<sha>`（详情）
 * 互为子串，所以用 `respond` 按 URL 分流，不靠顺序。
 */
/**
 * 假网络。
 *
 * **只有一个路由处理提交详情**：`/git/commits/<sha>`（元数据阶段拿根树）与
 * `/commits/<sha>`（历史整理拿文件清单）指向同一个提交，用正则一起接住。
 *
 * 踩过的坑：这两条各配一个路由时，`responses` 序列用的是**整个路由共享一个计数器**，
 * 元数据阶段那一次会把序列消耗掉，之后历史整理问的每个提交都拿到同一个兜底响应
 * （空对象）→ `files` 为空 → 一个时间都算不出来。所以这里统一走 `respond` 按 URL 现算。
 */
function historyFake(): FakeFetch {
  return new FakeFetch([
    { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'C1' } } }] },
    {
      match: '/git/trees/t1',
      responses: [
        {
          json: {
            sha: 't1',
            truncated: false,
            tree: [
              { path: 'C1.md', mode: '100644', type: 'blob', sha: 's1', size: 10 },
              { path: 'C2.md', mode: '100644', type: 'blob', sha: 's2', size: 10 },
            ],
          },
        },
      ],
    },
    { match: '/git/blobs/', responses: [{ text: '' }] },
    {
      match: /\/repos\/owner\/repo\/(git\/)?commits/,
      responses: [{ json: {} }],
      respond: (url: string): Response | undefined => {
        // 提交列表（新→旧），一页给完
        if (url.includes('/commits?')) {
          return Response.json(
            COMMITS.map((c) => ({ sha: c.sha, commit: { committer: { date: c.date } } })),
          );
        }
        // 详情请求会带 `?per_page=100&page=N`（取全文件清单要翻页），
        // 所以 sha 要切到 `?` 为止，否则会去查 `C1?per_page=100&page=1` 而查不到
        const sha = (url.split('/commits/')[1] ?? '').split('?')[0] ?? '';
        const idx = COMMITS.findIndex((c) => c.sha === sha);
        if (idx < 0) return Response.json({ message: 'not found' }, { status: 404 });
        const c = COMMITS[idx]!;
        const parent = COMMITS[idx + 1];
        // 只要一页就够（每个提交只改一个文件），第二页给空数组让翻页停下
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        if (page > 1) return Response.json({ sha: c.sha, files: [] });
        // 同一个响应要同时满足两种用途：元数据阶段用 tree，历史整理用 files
        return Response.json({
          sha: c.sha,
          tree: { sha: 't1' },
          message: '',
          parents: parent ? [{ sha: parent.sha }] : [],
          commit: { committer: { date: c.date } },
          files: [{ filename: `${c.sha}.md`, status: 'modified' }],
        });
      },
    },
  ]);
}

const resetState = (): void => {
  useNotes.setState({
    ready: false,
    order: [],
    current: null,
    content: '',
    mode: 'read',
    dirty: false,
    drawerOpen: false,
    error: null,
    toast: null,
    syncStage: '',
    lastSyncNote: '',
    histNote: '',
    histDone: 0,
    histTotal: 0,
  });
};

beforeEach(() => {
  __abortContentPullForTest();
  resetState();
  __setFetchForTest(undefined);
});

async function configureAndSync(fake: FakeFetch): Promise<MemoryFileStore> {
  __setFetchForTest(fake.fetch);
  const fs = new MemoryFileStore();
  await useNotes.getState().init(fs);
  await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
  // 走界面点"同步"的那条路径：读清单 + 后台下内容 + 后台核对真实时间
  await useNotes.getState().syncNow();
  await __awaitMtimeRefreshForTest();
  await __awaitContentPullForTest();
  return fs;
}

const readMeta = async (fs: MemoryFileStore) => deserializeMeta((await fs.readText(MANIFEST_FILE))!);
const strip = (u: string): string => u.replace('https://api.github.com/repos/owner/repo', '');

describe('反推真实修改时间', () => {
  it('**点一次同步，返回时时间就已经就位**（不能靠后台自己慢慢补）', async () => {
    /*
     * 这条守的是一个曾经真实发生过的顺序问题：同步时内容下载与历史整理**同时起飞**，
     * 而额度只有一份。正文下载（首启 300 篇 = 300 个请求）把它吃光，历史整理
     * （150 个请求）几乎必然饿死 —— 表现是整个列表全是"时间未知"，顺序完全是乱的。
     *
     * 所以判据不是"最终能不能拿到时间"（那种测试即使顺序反了也会通过，因为后台
     * 终究会跑完），而是 **`syncNow()` 返回时时间有没有就位** —— 这才是用户看到的东西。
     */
    const fake = historyFake();
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
    await useNotes.getState().syncNow();

    // 刻意**不** await 任何后台任务：就是要看这一刻的状态
    const s = useNotes.getState();
    expect(s.histNote).not.toBe(''); // 整理这一步真的跑完了
    const filled = Object.values(s.meta.notes).filter((e) => hasRealMtime(e)).length;
    expect(filled).toBeGreaterThan(0);
    // 落盘的那份也必须一致，否则重开应用又是"未知"
    const meta = await readMeta(fs);
    expect(Object.values(meta.notes).filter((e) => hasRealMtime(e)).length).toBe(filled);

    await __awaitMtimeRefreshForTest();
    await __awaitContentPullForTest();
  });

  it('只问该问的端点（提交列表 + 逐个提交详情），不碰区间比较', async () => {
    const fake = historyFake();
    await configureAndSync(fake);
    const urls = fake.requests.map((r) => strip(r.url));

    expect(urls.filter((u) => u.startsWith('/commits?'))).toHaveLength(1); // 列一次历史
    // 逐个提交问：4 个提交各一次，外加元数据阶段问最新提交拿根树的那一次
    // （注意真实路径是 `/commits/{sha}`，**没有** `/git/` 前缀；写错过一次）
    // 详情请求带分页参数（`?per_page=100&page=N`），每个提交只改一个文件所以只翻一页
    expect(urls.filter((u) => /^\/commits\/[^?]+\?per_page=100&page=1$/.test(u))).toHaveLength(4);
    // 元数据阶段问最新提交拿根树，走的是另一条路径（`/git/commits/`，这里带 `git`）
    expect(urls.filter((u) => u.startsWith('/git/commits/'))).toHaveLength(1);
    // 关键：按区间比较问会撞 300 条静默截断，绝不能走那条路
    expect(urls.some((u) => u.includes('/compare/'))).toBe(false);
  });

  it('每篇拿到的是它自己那次提交的时间，而不是"下载时刻"', async () => {
    const fs = await configureAndSync(historyFake());
    const meta = await readMeta(fs);

    // C1.md 由 C1 改、C2.md 由 C2 改 → 各拿各的时间
    expect(meta.notes['C1.md']!.fileMtime).toBe(Date.parse(COMMITS[0]!.date));
    expect(meta.notes['C2.md']!.fileMtime).toBe(Date.parse(COMMITS[1]!.date));
    for (const path of ['C1.md', 'C2.md']) {
      const e = meta.notes[path]!;
      expect(hasRealMtime(e)).toBe(true);
      expect(effectiveMtime(e)).toBe(e.fileMtime);
      // 与"落盘时刻"必须不是一回事（后者是当前时间）
      expect(e.mtime).not.toBe(e.fileMtime);
    }
  });

  it('整理完记下前沿；再整理一次不再逐提交重问', async () => {
    const fake = historyFake();
    const fs = await configureAndSync(fake);
    expect((await readMeta(fs)).histFrontier).toBe('C4'); // 本次走到的最旧那个提交

    const before = fake.requests.length;
    const detail = (): number =>
      fake.requests.filter((r) => /\/commits\/[^?]+$/.test(r.url)).length;
    const detailBefore = detail();

    await useNotes.getState().refreshMtimes();

    // 契约：前沿没动时**不逐提交重问**（那才是随历史长度增长的开销）。
    // 只允许花定量的几个请求去确认"没有新东西"。
    expect(detail()).toBe(detailBefore);
    expect(fake.requests.length - before).toBeLessThanOrEqual(2);
  });

  it('落盘的 fileMtime 与内存里一致（不是只改了界面）', async () => {
    const fs = await configureAndSync(historyFake());
    const fromDisk = await readMeta(fs);
    const fromMem = useNotes.getState().meta;
    expect(Object.keys(fromMem.notes).length).toBeGreaterThan(0);
    for (const path of Object.keys(fromMem.notes)) {
      expect(fromDisk.notes[path]!.fileMtime).toBe(fromMem.notes[path]!.fileMtime);
    }
  });

  it('历史里没有的笔记如实标"时间未知"，不编一个时间', async () => {
    // 树里有「甲.md」，但历史里从来没出现过它
    const fake = new FakeFetch([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      {
        match: '/git/trees/t1',
        responses: [
          {
            json: {
              sha: 't1',
              truncated: false,
              tree: [{ path: '甲.md', mode: '100644', type: 'blob', sha: 'sa', size: 5 }],
            },
          },
        ],
      },
      { match: '/git/blobs/', responses: [{ text: '' }] },
      {
        match: /commits/,
        responses: [{ json: [] }],
        respond: (url: string): Response | undefined => {
          if (url.includes('/commits?')) {
            return Response.json([
              { sha: 'c1', commit: { committer: { date: '2026-01-01T00:00:00Z' } } },
            ]);
          }
          // 第二页起给空数组，让翻页停下
          if (Number(new URL(url).searchParams.get('page') ?? '1') > 1) {
            return Response.json({ sha: 'c1', files: [] });
          }
          // 这个提交只改了「别的.md」，「甲.md」在历史里从没出现过
          return Response.json({
            sha: 'c1',
            tree: { sha: 't1' },
            parents: [],
            commit: { committer: { date: '2026-01-01T00:00:00Z' } },
            files: [{ filename: '别的.md' }],
          });
        },
      },
    ]);
    const fs = await configureAndSync(fake);
    const e = (await readMeta(fs)).notes['甲.md']!;
    expect(hasRealMtime(e)).toBe(false);
    // 没有真实时间时退回落盘时间（保证排序稳定），界面上会显示"时间未知"
    expect(effectiveMtime(e)).toBe(e.mtime);
    expect(useNotes.getState().order).toEqual(['甲.md']); // 列表照旧可用
  });

  it('整理失败不影响已经可用的列表（不算同步失败）', async () => {
    // 不给历史路由：提交列表请求拿不到东西
    const fake = new FakeFetch([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      {
        match: /commits/,
        responses: [{ json: {} }],
        respond: (url: string): Response | undefined => {
          if (url.includes('/commits?')) return Response.json([]);
          if (Number(new URL(url).searchParams.get('page') ?? '1') > 1) {
            return Response.json({ sha: 'c1', files: [] });
          }
          return Response.json({ sha: 'c1', tree: { sha: 't1' } });
        },
      },
      {
        match: '/git/trees/t1',
        responses: [
          {
            json: {
              sha: 't1',
              truncated: false,
              tree: [{ path: '甲.md', mode: '100644', type: 'blob', sha: 'sa', size: 5 }],
            },
          },
        ],
      },
      { match: '/git/blobs/', responses: [{ text: '' }] },
    ]);
    const fs = await configureAndSync(fake);

    const s = useNotes.getState();
    expect(s.order).toEqual(['甲.md']);
    expect(s.error).toBeNull();
    expect(hasRealMtime((await readMeta(fs)).notes['甲.md'])).toBe(false);
  });
});

describe('排序：近期修改的必须在上面', () => {
  it('时间未知的笔记沉到下面，绝不用"下载时刻"顶上去', async () => {
    // 「甲.md」在版本历史里没出现过 → 时间未知
    const fake = new FakeFetch([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      {
        match: '/git/trees/t1',
        responses: [
          {
            json: {
              sha: 't1',
              truncated: false,
              tree: [
                { path: '老笔记.md', mode: '100644', type: 'blob', sha: 's0', size: 5 },
                { path: '刚改过.md', mode: '100644', type: 'blob', sha: 's1', size: 5 },
              ],
            },
          },
        ],
      },
      { match: '/git/blobs/', responses: [{ text: '' }] },
      {
        match: /commits/,
        responses: [{ json: [] }],
        respond: (url: string): Response | undefined => {
          if (url.includes('/commits?')) {
            return Response.json([{ sha: 'c1', commit: { committer: { date: '2020-01-01T00:00:00Z' } } }]);
          }
          if (Number(new URL(url).searchParams.get('page') ?? '1') > 1) return Response.json({ files: [] });
          // 只改了「刚改过.md」；「老笔记.md」没在历史里出现过
          return Response.json({
            sha: 'c1',
            tree: { sha: 't1' },
            parents: [],
            commit: { committer: { date: '2020-01-01T00:00:00Z' } },
            files: [{ filename: '刚改过.md' }],
          });
        },
      },
    ]);
    await configureAndSync(fake);

    // 关键：两篇都是"刚刚下载"的，但排序必须是「有真实时间的」在前
    expect(useNotes.getState().order).toEqual(['刚改过.md', '老笔记.md']);
  });

  it('一次同步只走一段窗口，剩下的留给下次（首轮就能看到效果）', async () => {
    // 造 8 个提交，窗口设为 3
    const many = Array.from({ length: 8 }, (_, i) => ({
      sha: `c${i + 1}`,
      date: new Date(Date.UTC(2026, 0, 20) - i * 86_400_000).toISOString(),
    }));
    const fake = new FakeFetch([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      {
        match: '/git/trees/t1',
        responses: [
          {
            json: {
              sha: 't1',
              truncated: false,
              tree: [{ path: 'c1.md', mode: '100644', type: 'blob', sha: 's1', size: 5 }],
            },
          },
        ],
      },
      { match: '/git/blobs/', responses: [{ text: '' }] },
      {
        match: /commits/,
        responses: [{ json: [] }],
        respond: (url: string): Response | undefined => {
          if (url.includes('/commits?')) {
            return Response.json(
              many.map((c) => ({ sha: c.sha, commit: { committer: { date: c.date } } })),
            );
          }
          const sha = (url.split('/commits/')[1] ?? '').split('?')[0] ?? '';
          if (Number(new URL(url).searchParams.get('page') ?? '1') > 1) return Response.json({ files: [] });
          return Response.json({ sha, tree: { sha: 't1' }, parents: [], commit: { committer: { date: many.find((m) => m.sha === sha)?.date ?? '' } }, files: [{ filename: `${sha}.md` }] });
        },
      },
    ]);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
    await useNotes.getState().pullMetadata();

    // 走一次，窗口 3
    await useNotes.getState().refreshMtimes({ maxCommits: 3 });
    const meta1 = useNotes.getState().meta;
    expect(meta1.histFrontier).toBe('c3'); // 走到的位置
    const dated = Object.values(meta1.notes).filter((e) => hasRealMtime(e));
    expect(dated).toHaveLength(1); // 只算到 c1..c3 里改过的

    // 再走一次，接着往旧走（不是从头重来）
    const before = fake.requests.length;
    await useNotes.getState().refreshMtimes({ maxCommits: 3 });
    const meta2 = useNotes.getState().meta;
    expect(meta2.histFrontier).toBe('c6');
    expect(fake.requests.length).toBeGreaterThan(before);
  });
});

describe('搜索结果就是列表顺序的子序列', () => {
  it('搜同一个词，命中顺序与列表完全一致（不按文件名、不按下载时刻）', async () => {
    // 三篇的文件名都含"关键词"（文件名命中只查内存，零 IO），
    // 且三篇的落盘时刻相同（"刚刚下载"）—— 唯一的差别只有反推出来的真实时间
    const fs = new MemoryFileStore({
      'notes/关键词-未知.md': 'x',
      'notes/关键词-最新.md': 'x',
      'notes/关键词-居中.md': 'x',
    });
    resetState();
    await useNotes.getState().init(fs);

    const entry = (fileMtime: number) => ({
      path: '',
      localSha: 's',
      remoteSha: 's',
      syncedSha: 's',
      size: 1,
      mtime: Date.UTC(2026, 0, 1), // 下载时刻全一样，排除干扰
      fileMtime,
      flags: 8,
    });
    const notes = {
      '关键词-未知.md': entry(0), // 时间未知
      '关键词-最新.md': entry(Date.UTC(2026, 8, 1)),
      '关键词-居中.md': entry(Date.UTC(2025, 0, 1)),
    };
    useNotes.setState((s) => ({ meta: { ...s.meta, notes } }));

    // 没有公开的"重排"动作，这里按同一套规则算一遍（与 store 里的 byMtimeDesc 一致：
    // 时间已知的按真实时间倒序在前，未知的整组在后）。真实环境里同步/保存后会自动重排。
    const meta = useNotes.getState().meta;
    const list = Object.keys(notes).sort((a, b) => {
      const ka = meta.notes[a]!.fileMtime > 0;
      const kb = meta.notes[b]!.fileMtime > 0;
      if (ka !== kb) return ka ? -1 : 1;
      const va = ka ? meta.notes[a]!.fileMtime : meta.notes[a]!.mtime;
      const vb = kb ? meta.notes[b]!.fileMtime : meta.notes[b]!.mtime;
      return vb - va;
    });
    useNotes.setState({ order: list });

    await useNotes.getState().setSearchQuery('关键词');

    // 列表：最新的在上、未知的在最下。搜索必须给出**同一个相对顺序**（子序列）
    expect(list).toEqual(['关键词-最新.md', '关键词-居中.md', '关键词-未知.md']);
    expect(useNotes.getState().visible()).toEqual(list);
  });
});
