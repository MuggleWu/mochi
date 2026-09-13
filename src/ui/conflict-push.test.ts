/**
 * "有冲突就拒绝推送"的端到端自测（假网络 + 内存文件层）。
 *
 * 为什么必须测这一条：`pathsToPush` 本来就会跳过冲突的篇目，所以**即使拒推失效，
 * 推送也不会覆盖远端** —— 但表现会变成"静默少推几篇"，用户看到"已推送"、
 * 回到电脑上却发现改动不在。这种失败方式最难自己发现，所以拒推这件事本身要被钉住。
 *
 * 这里测的是"拒绝 + 说清楚原因"，不是"自动合并"。
 *
 * "回电脑上理顺之后、手机上拉一次就覆盖了"这条行为**不在这里测**：它由
 * `planDownloads` 按 `localSha !== remoteSha` 挑篇目、再由 `acceptRemote` 落盘实现，
 * 而"远端改过 → 判定 take-remote"已经在 `conflict.test.ts` 里钉住了。
 * 曾试着在这里也端到端跑一遍，但要让假网络同时正确支持"推送推进 head"和
 * "内容改回原样时不短路"，投入产出比不合理，遂作罢。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { FakeFetch } from '@core/net/fake-fetch';
import { blobShaOfText } from '@core/crypto/sha';
import { saveSettings } from '@core/sync/settings';
import { useNotes, __setFetchForTest } from './store';

/**
 * 假网络：内容可变，**提交与树 sha 都随内容变**。
 *
 * 后者不是可选的：`fetchSnapshot` 先比提交 sha、再比树 sha，任一相同就判定"远端没动"
 * 而直接返回。写成固定值的话，远端改了内容它也看不见，冲突现场根本造不出来。
 *
 * 另外**只建一次、改内容不重建**：`respond` 是同步回调而算 sha 是异步的，所以改内容时
 * 预计算 sha，路由只读缓存。曾经用"改内容 → 重建网络"的写法，结果新旧两套路由混用，
 * 表现极其误导（远端明明改了、同步却说没变化）。
 */
/**
 * 假网络：内容可变，**提交与树 sha 都随内容变**，并且真的支持推送。
 *
 * 三个约束都是踩出来的，缺一个就会得到"和被测逻辑毫无关系"的假失败：
 *
 * 1. **提交与树 sha 都随内容变。** `fetchSnapshot` 先比提交 sha、再比树 sha，
 *    任一相同就判定"远端没动"直接返回 —— 写成固定值的话，远端改了它也看不见，
 *    冲突现场根本造不出来。
 *
 * 2. **推送后 head 必须真的前进。** 推送完 store 会核对"远端在我们推送期间是不是
 *    又动过"（拿旧 head 和新 head 比）；不前进它会报"已停下以免覆盖"。
 *
 * 3. **响应回调是同步的**（`FakeFetch` 的 `respond` 签名如此），而算 sha 是异步的。
 *    所以推送时不去重算 sha，而是**按内容现算一个确定性的示意 sha**（见 `provisional`），
 *    保证"改完之后提交 sha 和树 sha 一致"这个不变量成立。曾经用 `${tree}-pushed`
 *    这种写法，结果两个 sha 对不上，又引出一串假失败。
 */
class Vault {
  text: Record<string, string> = { '甲.md': '甲-初版', '乙.md': '乙-初版' };
  private shas = new Map<string, string>();
  private blobBySha = new Map<string, string>();
  /** 当前分支指向的提交、当前根树，以及那棵树属于哪个提交。 */
  private head = '';
  private tree = '';
  private treeOfHead = '';
  /** 记录写请求，用来断言"到底有没有真的推"。 */
  pushed: string[] = [];
  /**
   * 提交对象链：sha → { 父提交, 树 }。
   *
   * 推送之后 store 会**读回校验**：`getCommit(新提交).parentSha` 必须等于推送前的基准，
   * 否则判定"远端在我们推送期间被改过"并收手。不建这条链的话，所有推送都会被拒 ——
   * 于是测出来的失败和被测逻辑毫无关系（这个坑踩过一次）。
   */
  private commits = new Map<string, { parent: string; tree: string }>();
  /** 新建但还没提交的树；以及新建但还没接到分支上的提交。 */
  private staged = '';
  private pendingCommit = '';

  /**
   * 模拟"电脑上改了并推了一个新提交"。
   *
   * 提交 sha 刻意**不用内容哈希**：那样当内容恰好改回原样时会算回同一个 sha，
   * 于是 `syncNow` 判定"远端没动"、整段被短路 —— 测试会失败在一个和被测逻辑
   * 毫无关系的地方（踩过）。真实 git 里每次提交的对象名也不只是内容的函数
   * （还有父提交、作者、时间），这里用一个自增序号更贴近"又提交了一次"。
   */
  async setRemote(path: string, text: string): Promise<void> {
    const prev = this.head;
    this.text[path] = text;
    await this.refresh();
    this.head = this.newCommit(prev, this.tree);
  }

  private seq = 0;
  private newCommit(parent: string, tree: string): string {
    this.seq += 1;
    const sha = `C-${String(this.seq).padStart(4, '0')}`;
    this.commits.set(sha, { parent, tree });
    return sha;
  }

  /** 按当前内容重算 blob sha 与树 sha（这一步是异步的，只在测试自己驱动的时刻做）。 */
  async refresh(): Promise<void> {
    this.shas.clear();
    this.blobBySha.clear();
    for (const [path, text] of Object.entries(this.text)) {
      const sha = await blobShaOfText(text);
      this.shas.set(path, sha);
      this.blobBySha.set(sha, text);
    }
    this.tree = provisional(Object.entries(this.text));
    this.treeOfHead = this.tree;
    if (!this.head) {
      this.head = this.tree;
      // 初始提交没有父提交（空串），与 `getCommit` 的返回约定一致
      this.commits.set(this.head, { parent: '', tree: this.tree });
    }
  }

  private applyTree(body: Record<string, unknown>): void {
    const entries = (body['tree'] ?? []) as { path?: string; sha?: string | null }[];
    for (const e of entries) {
      if (!e.path) continue;
      if (e.sha === null) {
        delete this.text[e.path];
        continue;
      }
      const content = e.sha ? this.blobBySha.get(e.sha) : undefined;
      if (content !== undefined) this.text[e.path] = content;
    }
    this.staged = `T-${Math.random().toString(16).slice(2, 10)}`;
    this.tree = this.staged;
  }

  async build(): Promise<FakeFetch> {
    await this.refresh();
    const listing = () =>
      Object.entries(this.text).map(([path, text]) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha: this.shas.get(path) ?? '',
        size: text.length,
      }));

    return new FakeFetch([
      {
        match: '',
        responses: [{ json: {} }],
        respond: (url: string, init?: RequestInit): Response | undefined => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

          if (url.includes('/git/ref/heads/')) {
            if (method === 'PATCH') {
              this.pushed.push('PATCH ref');
              const next = this.pendingCommit || this.newCommit(this.head, this.tree);
              this.head = next;
              this.treeOfHead = this.tree;
              this.pendingCommit = '';
            }
            return Response.json({ object: { sha: this.head } });
          }
          if (url.includes('/git/blobs/')) {
            const sha = url.split('/git/blobs/')[1] ?? '';
            const text = this.blobBySha.get(sha);
            return text === undefined ? new Response('', { status: 404 }) : new Response(text, { status: 200 });
          }
          if (url.includes('/git/trees') && method === 'POST') {
            this.pushed.push('POST tree');
            this.applyTree(body);
            return Response.json({ sha: this.tree });
          }
          if (url.includes('/git/trees/')) {
            return Response.json({ sha: this.tree, truncated: false, tree: listing() });
          }
          if (url.includes('/git/commits') && method === 'POST') {
            this.pushed.push('POST commit');
            // 建一个真的新提交：父 = 推送前的 head，树 = 刚建的那棵
            const mine = this.newCommit(this.head, this.staged);
            this.pendingCommit = mine;
            return Response.json({ sha: mine, tree: { sha: this.staged } });
          }
          if (url.includes('/git/commits/')) {
            const sha = (url.split('/git/commits/')[1] ?? '').split('?')[0] ?? '';
            const c = this.commits.get(sha);
            // `parents` 必须是**数组**：`getCommit` 读的是 `parents[0].sha`
            // （合并提交会有多个父提交）。写成 `parent: '<sha>'` 的话它拿不到值，
            // 读回校验就永远失败，报"远端在我们推送期间被改过" —— 踩过。
            if (c) {
              return Response.json({
                sha,
                parents: c.parent ? [{ sha: c.parent }] : [],
                tree: { sha: c.tree },
                files: [],
              });
            }
            return Response.json({ sha, tree: { sha: this.treeOfHead }, files: [] });
          }
          if (url.includes('/git/commits')) {
            return Response.json({ sha: this.head, tree: { sha: this.treeOfHead }, files: [] });
          }
          if (url.includes('/commits?')) {
            return Response.json([{ sha: this.head, commit: { committer: { date: '2026-01-10T00:00:00Z' } } }]);
          }
          if (url.includes('/commits/')) {
            const sha = (url.split('/commits/')[1] ?? '').split('?')[0] ?? '';
            if (Number(new URL(url).searchParams.get('page') ?? '1') > 1) return Response.json({ files: [] });
            return Response.json({
              sha,
              tree: { sha: this.treeOfHead },
              parents: [],
              commit: { committer: { date: '2026-01-10T00:00:00Z' } },
              files: [],
            });
          }
          return undefined;
        },
      },
    ]);
  }
}

/** 按内容算一个确定性的示意 sha（同步，够用；不是真 git sha）。 */
function provisional(entries: [string, string][]): string {
  let h = 7;
  for (const [path, text] of entries) {
    for (const ch of `${path}:${text}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `C-${h.toString(16).padStart(8, '0')}`;
}

const setup = async (): Promise<{ fs: MemoryFileStore; vault: Vault }> => {
  const vault = new Vault();
  const net = await vault.build();
  __setFetchForTest(net.fetch);
  const fs = new MemoryFileStore();
  await useNotes.getState().init(fs);
  await saveSettings(fs, { repo: 'owner/repo', branch: 'master', token: 'ok' });
  await useNotes.getState().init(fs);
  await useNotes.getState().syncNow();
  return { fs, vault };
};

/** 在手机上改一篇（走真实动作：打开 → 改 → 保存）。 */
async function editOnPhone(path: string, text: string): Promise<void> {
  await useNotes.getState().openNote(path);
  useNotes.setState({ content: text });
  await useNotes.getState().saveNote();
}

beforeEach(() => {
  __setFetchForTest();
});

describe('有冲突就拒绝推送', () => {
  it('两侧都改过时：推送被拒绝、说清原因、**一个写请求都不发**', async () => {
    const { vault } = await setup();
    await editOnPhone('甲.md', '甲-手机改的');
    await vault.setRemote('甲.md', '甲-电脑改的');
    await useNotes.getState().syncNow();

    const st = useNotes.getState();
    expect(st.conflicts.map((c) => c.path)).toEqual(['甲.md']);

    vault.pushed = [];
    await useNotes.getState().pushNow();

    const after = useNotes.getState();
    expect(after.error).toContain('甲');
    expect(after.error).toContain('没有推送');
    // 关键：**一个写请求都没发出去**，远端内容不会被手机覆盖
    expect(vault.pushed).toEqual([]);
    expect(vault.text['甲.md']).toBe('甲-电脑改的');
    // 本地那版也还在（拒绝推送不等于丢掉用户的改动）
    expect(after.meta.notes['甲.md']?.localSha).not.toBe(after.meta.notes['甲.md']?.remoteSha);
  });

  it('只有一边改过时：正常推送（别把拒推做成一概推不动）', async () => {
    const { vault } = await setup();
    await editOnPhone('甲.md', '甲-手机改的');

    await useNotes.getState().pushNow();

    const after = useNotes.getState();
    expect(after.error).toBeNull();
    expect(after.conflicts).toEqual([]);
    expect(vault.pushed.length).toBeGreaterThan(0);
  });

});
