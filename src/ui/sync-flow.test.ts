/**
 * 同步流程的端到端自测（假网络 + 内存文件层）。
 *
 * M1 的验收：配置好仓库后同步一次，抽屉里就出现远端全部笔记（按修改时间倒序）。
 * M2 的验收：清单到位后**自动**接着下内容（先最近 300 篇，再后台补齐），
 * 下载来的内容 sha 与远端一致、且**不会被标成本地改动**（否则会产生假冲突）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { MANIFEST_FILE } from '@core/fs/layout';
import { FakeFetch } from '@core/net/fake-fetch';
import { FLAG, deserializeMeta } from '@core/sync/manifest';
import { blobShaOfText } from '@core/crypto/sha';
import {
  useNotes,
  __abortContentPullForTest,
  __awaitContentPullForTest,
  __setFetchForTest,
} from './store';

const resetState = (): void => {
  useNotes.setState({
    ready: false,
    loadStage: '',
    order: [],
    current: null,
    content: '',
    mode: 'read',
    dirty: false,
    drawerOpen: false,
    query: '',
    scrollRatio: 0,
    error: null,
    toast: null,
    syncStage: '',
    lastSyncNote: '',
  });
};

/**
 * 带 blob 内容的下拉假网络。
 *
 * blob 路由必须**排在树路由之后并用正则限定**：树路由的 match 是子串 `'/git/trees/t1'`，
 * 若 blob 路由写成子串 `/git/blobs/` 也会被树请求先命中（反向亦然），断言就会串。
 * 这里用 `\/git\/blobs\/<sha>$` 精确到 sha。
 */
class TreeFake extends FakeFetch {
  private readonly bodies = new Map<string, string>();

  constructor(entries: Array<Record<string, unknown>>) {
    super([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      { match: '/git/commits/c1', responses: [{ json: { sha: 'c1', tree: { sha: 't1' } } }] },
      { match: '/git/trees/t1', responses: [{ json: { sha: 't1', truncated: false, tree: entries } }] },
      {
        // 正则限定到 sha：写成子串 `/git/blobs/` 虽然更宽，但树路由的 match 也是子串，
        // 两者会互相抢先命中，断言就串了
        match: /\/git\/blobs\/[^/]+$/,
        responses: [{ text: '' }],
        respond: (url: string): Response | undefined => {
          const sha = url.split('/git/blobs/')[1]?.split('?')[0] ?? '';
          const text = this.bodies.get(sha);
          // 没预设过的 sha 走 responses 的默认空串（表示"非笔记文件"之类）
          return text === undefined ? undefined : new Response(text, { status: 200 });
        },
      },
    ]);
  }

  /** 预设某个 sha 的 blob 内容。按 sha 精确匹配，与下载顺序无关。 */
  addBlob(sha: string, text: string): void {
    this.bodies.set(sha, text);
  }
}

const treeFake = (entries: Array<Record<string, unknown>>): TreeFake => new TreeFake(entries);

/**
 * 只统计**元数据路径**的请求。
 *
 * 为什么需要：清单一到手，内容下载就会在后台自动开跑（`void pullContent()`），
 * 请求总数里混着 blob 请求，断言"短路后只发 1 个请求"就没法写了。
 */
const metaRequests = (fake: FakeFetch): Array<{ url: string }> =>
  fake.requests.filter((r) => !r.url.includes('/git/blobs/'));

/**
 * 造一条**内容与 sha 对得上**的树条目。
 *
 * 为什么不能图省事随便编个 sha：下载路径会校验 sha（见 NotesRepo.acceptRemote），
 * 编的 sha 一定对不上，测试就会变成"验证拒绝落盘"而不是"验证下载成功"。
 */
const realBlob = async (path: string, content: string): Promise<Record<string, unknown>> => ({
  path,
  mode: '100644',
  type: 'blob',
  sha: await blobShaOfText(content),
  size: new TextEncoder().encode(content).byteLength,
});

const blob = (path: string, size = 100): Record<string, unknown> => ({
  path,
  mode: '100644',
  type: 'blob',
  sha: `sha-${path}`,
  size,
});

beforeEach(() => {
  // 先作废上一个用例可能还在跑的内容拉取：它是后台跑的（`void pullContent()`），
  // 不作废的话会带着"上一个用例的请求"进入本用例的断言
  __abortContentPullForTest();
  resetState();
  __setFetchForTest(undefined);
});

describe('未配置时', () => {
  it('给出明确提示，不发起任何请求', async () => {
    const fake = new FakeFetch([]);
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(new MemoryFileStore());

    await useNotes.getState().pullMetadata();
    expect(useNotes.getState().error).toContain('还没有配置同步仓库');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('配置后拉取元数据', () => {
  it('三个请求先拿到全部笔记，列表按修改时间倒序', async () => {
    const fake = treeFake([blob('甲笔记.md', 10), blob('乙笔记.md', 20), blob('丙笔记.md', 30)]);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });

    // 内容拉取是后台起的，这里先不让它跑完，好断言"元数据阶段"到底发了几个请求
    const snapshot = fake.requests.length;
    await useNotes.getState().pullMetadata();
    expect(snapshot).toBe(0);
    // 元数据阶段只有 ref + commit + tree 三个请求（内容请求是之后才有的）
    expect(fake.requests.filter((r) => !r.url.includes('/git/blobs/')).map((r) => r.method)).toEqual([
      'GET',
      'GET',
      'GET',
    ]);

    const s = useNotes.getState();
    expect(s.error).toBeNull();
    expect(s.order).toHaveLength(3);
    expect(s.order.sort()).toEqual(['丙笔记.md', '乙笔记.md', '甲笔记.md']);
    expect(s.lastSyncNote).toContain('3 篇');

    // 清单已落盘，且条目带「仅元数据」标记
    const persisted = deserializeMeta((await fs.readText(MANIFEST_FILE))!);
    expect(persisted.lastCommit).toBe('c1');
    expect(persisted.lastTree).toBe('t1');
    expect(persisted.notes['甲笔记.md']!.flags & FLAG.METADATA_ONLY).toBe(FLAG.METADATA_ONLY);
    await __awaitContentPullForTest();
  });

  it('清单到位后自动下内容，且下好的内容不被标成本地改动', async () => {
    const jia = '# 甲\n\n$\\frac{a}{b}$';
    const yi = '乙的正文';
    const fake = treeFake([await realBlob('甲笔记.md', jia), await realBlob('乙笔记.md', yi)]);
    fake.addBlob(await blobShaOfText(jia), jia);
    fake.addBlob(await blobShaOfText(yi), yi);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });
    await useNotes.getState().pullMetadata();
    await __awaitContentPullForTest();

    // 两篇内容都下来了
    expect(await fs.readText('notes/甲笔记.md')).toContain('frac{a}{b}');
    expect(await fs.readText('notes/乙笔记.md')).toBe('乙的正文');

    // 关键：下好的内容必须与远端一致，且**没有 DIRTY 标记** —— 否则推送阶段会把
    // "刚从远端下的"误判成"手机改过"，产生一堆假冲突
    const meta = deserializeMeta((await fs.readText(MANIFEST_FILE))!);
    for (const path of ['甲笔记.md', '乙笔记.md']) {
      const e = meta.notes[path]!;
      expect(e.localSha).toBe(e.remoteSha);
      expect(e.syncedSha).toBe(e.remoteSha);
      expect(e.flags & FLAG.DIRTY).toBe(0);
    }
    expect(useNotes.getState().pendingContent).toBe(0);
    expect(useNotes.getState().pullStage).toBe('');
  });

  it('内容 sha 与远端不符时拒绝落盘（宁可当失败，也不写进"本地改动"）', async () => {
    const fake = treeFake([blob('甲笔记.md', 10)]);
    // 故意给一份与清单里 sha 对不上的内容：blob() 编的是 `sha-甲笔记.md`，与内容哈希必然不同
    fake.addBlob('sha-甲笔记.md', '内容被截断了');
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });
    await useNotes.getState().pullMetadata();
    await __awaitContentPullForTest();

    expect(fs.snapshot().some((f) => f.startsWith('notes/'))).toBe(false);
    const s = useNotes.getState();
    expect(s.pendingContent).toBe(1); // 还是欠着
    expect(s.lastSyncNote).toContain('失败');
  });

  it('本地内容 sha 与清单一致时才认（blobShaOfText 与清单同源）', async () => {
    // 这条是上面那条的对照：确认测试里的 sha 算法与实现是同一套，
    // 否则"拒绝落盘"那条会永远通过（因为所有内容都对不上）
    const text = '# 甲';
    const sha = await blobShaOfText(text);
    const fake = treeFake([{ path: '甲笔记.md', mode: '100644', type: 'blob', sha, size: 5 }]);
    fake.addBlob(sha, text);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });
    await useNotes.getState().pullMetadata();
    await __awaitContentPullForTest();

    expect(await fs.readText('notes/甲笔记.md')).toBe(text);
    expect(useNotes.getState().pendingContent).toBe(0);
  });

  it('同步失败时保留原有清单，并给出可照着做的提示', async () => {
    const fake = new FakeFetch([{ match: '/git/ref', responses: [{ status: 401, text: '{"message":"Bad credentials"}' }] }]);
    __setFetchForTest(fake.fetch);

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(new MemoryFileStore());
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'bad' });
    const before = useNotes.getState().order;

    await useNotes.getState().pullMetadata();
    const s = useNotes.getState();
    expect(s.error).toContain('访问令牌无效');
    expect(s.error).toContain('重新生成'); // 提示里告诉下一步做什么
    expect(s.order).toEqual(before); // 清单没被破坏
    expect(s.syncStage).toBe('');
  });

  it('404 的提示同时说明两种可能（仓库名错 / 令牌没授权）', async () => {
    const fake = new FakeFetch([{ match: '/git/ref', responses: [{ status: 404, text: '{"message":"Not Found"}' }] }]);
    __setFetchForTest(fake.fetch);

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(new MemoryFileStore());
    await useNotes.getState().saveConfig({ repo: 'owner/wrong', branch: 'master', token: 'tok' });
    await useNotes.getState().pullMetadata();

    const err = useNotes.getState().error ?? '';
    expect(err).toContain('仓库或分支没找到');
    expect(err).toContain('令牌');
  });

  it('重复同步时若远端没动，只发 1 个请求就收工（不重下整棵树）', async () => {
    const fake = treeFake([blob('a.md'), blob('b.md')]);
    __setFetchForTest(fake.fetch);

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(new MemoryFileStore());
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });

    await useNotes.getState().pullMetadata();
    expect(metaRequests(fake)).toHaveLength(3); // 首次：ref + commit + tree

    await useNotes.getState().pullMetadata();
    // 第二次只查分支头，发现没动就短路 —— 递归树是同步里最贵的请求，
    // 实测一万篇的仓库它要下载 660 KB、23 秒
    // 元数据一到位就会自动开始下内容（后台），所以计数只统计元数据路径 ——
    // 这条用例要验的是"分支头没动就短路"，与内容下载无关
    expect(metaRequests(fake)).toHaveLength(4);
    expect(fake.count('/git/trees/')).toBe(1);
    expect(useNotes.getState().lastSyncNote).toContain('没有变化');
    expect(useNotes.getState().order).toHaveLength(2); // 清单原样保留
  });

  it('分支头动了但树没变时，靠 ETag 拿到 304，同样不下载', async () => {
    // 每个路由一条，按队列依次返回（写两条同样的 match 是错的：
    // 假 fetch 按首个匹配的路由取响应，第二条永远不会被用到）
    const fake = new FakeFetch([
      {
        match: '/git/ref/heads/master',
        responses: [{ json: { object: { sha: 'c1' } } }, { json: { object: { sha: 'c2' } } }],
      },
      {
        match: '/git/commits/',
        responses: [
          { json: { sha: 'c1', tree: { sha: 't1' } } },
          { json: { sha: 'c2', tree: { sha: 't1' } } },
        ],
      },
      {
        match: '/git/trees/t1',
        responses: [
          { json: { sha: 't1', truncated: false, tree: [blob('a.md')] }, headers: { etag: 'W/"e1"' } },
          { status: 304, text: '' },
        ],
      },
    ]);
    __setFetchForTest(fake.fetch);

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(new MemoryFileStore());
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });

    await useNotes.getState().pullMetadata();
    expect(useNotes.getState().meta.treeEtag).toBe('W/"e1"');

    await useNotes.getState().pullMetadata();
    const s = useNotes.getState();
    expect(s.error).toBeNull();
    expect(s.lastSyncNote).toContain('没有变化');
    // 第二次：ref + commit + 一次条件请求（304 后不再下载）
    expect(fake.requests.map((r) => r.url.replace('https://api.github.com/repos/owner/repo', ''))).toEqual([
      '/git/ref/heads/master',
      '/git/commits/c1',
      '/git/trees/t1?recursive=1',
      '/git/ref/heads/master',
      '/git/commits/c2',
      '/git/trees/t1?recursive=1',
    ]);
    const cond = fake.requests.filter((r) => r.headers['If-None-Match'] === 'W/"e1"');
    expect(cond).toHaveLength(1);
    expect(cond[0]!.url).toContain('/git/trees/t1');
    // 树没变，清单原样保留
    expect(s.order).toHaveLength(1);
    expect(s.meta.lastCommit).toBe('c1');
  });

  it('令牌不会被写进清单文件', async () => {
    const fake = treeFake([blob('a.md')]);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'secret-token-xyz' });
    await useNotes.getState().pullMetadata();

    const manifest = (await fs.readText(MANIFEST_FILE)) ?? '';
    expect(manifest).not.toContain('secret-token-xyz');
    // 令牌只应在设置文件里
    const settings = (await fs.readText('state/meta.json')) ?? '';
    expect(settings).toContain('secret-token-xyz');
  });
});
