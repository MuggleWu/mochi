/**
 * GitHub 客户端单测（全部离线，用假 fetch）。
 *
 * 重点是失败路径：超时、限流重试、404 的歧义提示、非快进冲突、推送只发 3 个请求。
 */
import { describe, expect, it } from 'vitest';
import { FakeFetch, type FakeRoute } from './fake-fetch';
import { GithubClient, GithubError, explainFailure, rootMarkdownFiles } from './github';
import { isNoteName } from '../paths';

type Route = FakeRoute;

const noBackoff = () => 0;

function makeClient(
  routes: ConstructorParameters<typeof FakeFetch>[0],
  opts: Partial<{ timeoutMs: number; maxRetryDelayMs: number }> = {},
) {
  const fake = new FakeFetch(routes);
  const client = new GithubClient({
    token: 'tok',
    repo: 'owner/repo',
    branch: 'master',
    fetchImpl: fake.fetch,
    backoffMs: noBackoff,
    maxRetryDelayMs: opts.maxRetryDelayMs ?? 0,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  return { client, fake };
}

describe('取单个提交的文件清单（反推修改时间用）', () => {
  /** 造 n 个文件。 */
  const files = (from: number, n: number): { filename: string }[] =>
    Array.from({ length: n }, (_, i) => ({ filename: `第${from + i}篇.md` }));

  it('不满一页就停，不多翻', async () => {
    const { client, fake } = makeClient([
      {
        match: '/commits/abc',
        responses: [{ json: { sha: 'abc', files: files(0, 7) } }],
      },
    ]);
    expect(await client.listCommitFiles('abc')).toHaveLength(7);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toContain('per_page=100&page=1');
  });

  it('满一页继续翻，直到不满一页为止', async () => {
    // 250 个文件 = 100 + 100 + 50，三页
    const { client, fake } = makeClient([
      {
        match: '/commits/abc',
        responses: [
          { json: { sha: 'abc', files: files(0, 100) } },
          { json: { sha: 'abc', files: files(100, 100) } },
          { json: { sha: 'abc', files: files(200, 50) } },
        ],
      },
    ]);
    const paths = await client.listCommitFiles('abc');
    expect(paths).toHaveLength(250);
    expect(paths[0]).toBe('第0篇.md');
    expect(paths[249]).toBe('第249篇.md');
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]!.url).toContain('page=3');
  });

  it('恰好整页时再翻一次确认到底（不能少最后一页）', async () => {
    // 100 + 0：第二页空 → 停。若写成"不满一页才停"而不翻这一次，就会漏
    const { client, fake } = makeClient([
      {
        match: '/commits/abc',
        responses: [
          { json: { sha: 'abc', files: files(0, 100) } },
          { json: { sha: 'abc', files: [] } },
        ],
      },
    ]);
    expect(await client.listCommitFiles('abc')).toHaveLength(100);
    expect(fake.requests).toHaveLength(2);
  });

  it('翻页有上限（异常巨大的提交也不会无限翻）', async () => {
    // 每一页都满 100：若不设上限就会一直翻下去
    const { client, fake } = makeClient([
      { match: '/commits/abc', responses: [{ json: { sha: 'abc', files: files(0, 100) } }] },
    ]);
    const paths = await client.listCommitFiles('abc');
    expect(paths.length).toBeGreaterThan(0);
    // 上限 30 页
    expect(fake.requests.length).toBeLessThanOrEqual(30);
  });

  it('没有 files 字段时返回空数组（不报错）', async () => {
    const { client } = makeClient([
      { match: '/commits/abc', responses: [{ json: { sha: 'abc' } }] },
    ]);
    expect(await client.listCommitFiles('abc')).toEqual([]);
  });

  it('文件名缺失的条目被跳过（不塞 undefined 进来）', async () => {
    const { client } = makeClient([
      {
        match: '/commits/abc',
        responses: [{ json: { sha: 'abc', files: [{ filename: '好.md' }, {}, { filename: 1 }, { filename: '也好.md' }] } }],
      },
    ]);
    expect(await client.listCommitFiles('abc')).toEqual(['好.md', '也好.md']);
  });
});

describe('读取', () => {
  it('分支头 → commit → 根树（3 次请求链路）', async () => {
    const { client, fake } = makeClient([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'commit1' } } }] },
      { match: '/git/commits/commit1', responses: [{ json: { sha: 'commit1', tree: { sha: 'tree1' }, message: 'm' } }] },
      {
        match: '/git/trees/tree1',
        responses: [
          {
            json: {
              sha: 'tree1',
              truncated: false,
              tree: [
                { path: 'a.md', mode: '100644', type: 'blob', sha: 'sha-a', size: 10 },
                { path: '.obsidian/app.json', mode: '100644', type: 'blob', sha: 'sha-cfg', size: 5 },
                { path: 'sub/b.md', mode: '100644', type: 'blob', sha: 'sha-sub', size: 7 },
                { path: 'images', mode: '040000', type: 'tree', sha: 'tree-img' },
              ],
            },
          },
        ],
      },
    ]);

    const head = await client.getRefHead();
    const commit = await client.getCommit(head);
    const listing = await client.listTree(commit.treeSha);

    expect(head).toBe('commit1');
    expect(commit.treeSha).toBe('tree1');
    expect(listing.truncated).toBe(false);

    const notes = rootMarkdownFiles(listing.entries, isNoteName);
    expect(notes.map((e) => e.path)).toEqual(['a.md']); // 子目录、配置、tree 条目全部排除
    expect(fake.count('/git/trees/tree1')).toBe(1);
  });

  it('带认证头与 no-store，且 URL 与分支正确', async () => {
    const { client, fake } = makeClient([{ match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'x' } } }] }]);
    await client.getRefHead();
    const req = fake.requests[0]!;
    expect(req.url).toBe('https://api.github.com/repos/owner/repo/git/ref/heads/master');
    expect(req.headers['Authorization']).toBe('Bearer tok');
    expect(req.headers['Accept']).toBe('application/vnd.github+json');
  });

  it('读 blob 文本走 raw，中文不乱码', async () => {
    const { client } = makeClient([{ match: '/git/blobs/sha-zh', responses: [{ text: '# 标题\n公式 $$x^2$$\n' }] }]);
    expect(await client.readBlobText('sha-zh')).toBe('# 标题\n公式 $$x^2$$\n');
  });

  it('分支里没有 sha 时报明确错误', async () => {
    const { client } = makeClient([{ match: '/git/ref/heads/master', responses: [{ json: { object: {} } }] }]);
    await expect(client.getRefHead()).rejects.toThrow(GithubError);
  });
});

describe('失败分类与提示', () => {
  it('401 → 令牌无效，提示重新生成', () => {
    const e = explainFailure(401, '{"message":"Bad credentials"}');
    expect(e.kind).toBe('auth');
    expect(e.hint).toContain('细粒度令牌');
  });

  it('404 → 必须同时说明「名字写错」与「令牌没授权」两种可能', () => {
    const e = explainFailure(404, '{"message":"Not Found"}');
    expect(e.kind).toBe('not-found');
    expect(e.hint).toContain('仓库名');
    expect(e.hint).toContain('令牌');
  });
  it('409 → 非快进冲突，明确要求先拉取且不覆盖远端', () => {
    const e = explainFailure(409, '{"message":"Update is not a fast forward"}');
    expect(e.kind).toBe('conflict');
    expect(e.hint).toContain('拉取');
    expect(e.hint).toContain('不会覆盖');
  });

  it('403 + rate limit → 限流分类', () => {
    expect(explainFailure(403, 'API rate limit exceeded').kind).toBe('rate-limit');
    expect(explainFailure(403, 'Resource not accessible').kind).toBe('forbidden');
  });

  it('超时会中止而不是永久卡住', async () => {
    const { client } = makeClient([{ match: '/git/ref', responses: [{ json: {}, delayMs: 50 }] }], { timeoutMs: 10 });
    await expect(client.getRefHead()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('网络异常分类为 network', async () => {
    const { client } = makeClient([{ match: '/git/ref', responses: [{ throws: 'network' }] }]);
    await expect(client.getRefHead()).rejects.toMatchObject({ kind: 'network' });
  });

  it('配额用尽不重试：重试是白费，还会把浪费乘以三', async () => {
    // 实测踩过：撞上每小时配额上限后，每个请求都要再重试两次，
    // 而"这一小时没额度了"重试多少次都没用 —— 纯粹的浪费，还刷屏错误。
    const { client, fake } = makeClient([
      {
        match: '/git/ref/heads/master',
        responses: [
          {
            status: 403,
            text: 'API rate limit exceeded for user ID 1',
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9999999999' },
          },
          { json: { object: { sha: 'ok' } } }, // 若真重试了，这里会成功、测试就会露馅
        ],
      },
    ]);
    await expect(client.getRefHead()).rejects.toThrow('额度已用完');
    expect(fake.count('/git/ref')).toBe(1);
  });

  it('次级限流（请求太密）仍然重试 —— 它几秒就恢复', async () => {
    const { client, fake } = makeClient([
      {
        match: '/git/ref/heads/master',
        responses: [
          { status: 403, text: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '0' } },
          { json: { object: { sha: 'ok' } } },
        ],
      },
    ]);
    expect(await client.getRefHead()).toBe('ok');
    expect(fake.count('/git/ref')).toBe(2);
  });

  it('每个响应都记下剩余额度（否则撞墙前毫无察觉）', async () => {
    const { client } = makeClient([
      {
        match: '/git/ref/heads/master',
        responses: [
          {
            json: { object: { sha: 'ok' } },
            headers: { 'x-ratelimit-remaining': '4321', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1700000000' },
          },
        ],
      },
    ]);
    expect(client.remainingQuota).toBeNull(); // 还没发过请求就不猜
    await client.getRefHead();
    expect(client.remainingQuota).toEqual({ remaining: 4321, limit: 5000, resetAt: 1_700_000_000_000 });
  });

  it('幂等请求遇 500 会重试，写请求不会重复提交', async () => {
    const { client, fake } = makeClient([
      { method: 'GET', match: '/git/trees/t', responses: [{ status: 500, text: 'boom' }, { json: { tree: [], sha: 't' } }] },
      { method: 'POST', match: '/git/commits', responses: [{ status: 500, text: 'boom' }] },
    ]);
    await expect(client.listTree('t')).resolves.toBeTruthy();
    expect(fake.count('/git/trees/t')).toBe(2);
    await expect(client.createCommit('t', 'p', 'm')).rejects.toMatchObject({ kind: 'server' });
    expect(fake.requests.filter((r) => r.url.includes('/git/commits')).length).toBe(1);
  });
});

describe('推送', () => {
  const pushes = (extra: ConstructorParameters<typeof FakeFetch>[0] = []) => [
    ...extra,
    { method: 'POST', match: '/git/trees', responses: [{ json: { sha: 'newtree' } }] },
    { method: 'POST', match: '/git/commits', responses: [{ json: { sha: 'newcommit' } }] },
    { method: 'PATCH', match: '/git/refs/heads/master', responses: [{ json: { object: { sha: 'newcommit' } } }] },
  ];

  it('一次推送正好 3 个请求，且内容内联、删除用 sha:null、force:false', async () => {
    const { client, fake } = makeClient(pushes());
    const res = await client.push({
      baseTree: 'base',
      parentCommit: 'parent',
      message: 'chore: 手机改动',
      changes: [
        { path: '新笔记.md', content: '# 新笔记' },
        { path: '改过的.md', content: '# 改了' },
        { path: '删掉的.md', delete: true },
      ],
    });

    expect(res).toEqual({ commitSha: 'newcommit', treeSha: 'newtree' });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((r) => r.method)).toEqual(['POST', 'POST', 'PATCH']);

    const treeBody = fake.requests[0]!.body as { base_tree: string; tree: Array<Record<string, unknown>> };
    expect(treeBody.base_tree).toBe('base');
    expect(treeBody.tree[0]).toEqual({ path: '新笔记.md', mode: '100644', type: 'blob', content: '# 新笔记' });
    expect(treeBody.tree[2]).toEqual({ path: '删掉的.md', mode: '100644', type: 'blob', sha: null });

    const commitBody = fake.requests[1]!.body as { tree: string; parents: string[]; message: string };
    expect(commitBody.parents).toEqual(['parent']);
    expect(commitBody.tree).toBe('newtree');

    const refBody = fake.requests[2]!.body as { sha: string; force: boolean };
    expect(refBody).toEqual({ sha: 'newcommit', force: false });
  });

  it('远端被推过 → 更新分支 409，抛冲突且绝不 force 覆盖', async () => {
    const { client, fake } = makeClient(
      pushes([{ method: 'PATCH', match: '/git/refs/heads/master', responses: [{ status: 409, text: 'Update is not a fast forward' }] }]),
    );
    await expect(
      client.push({ baseTree: 'base', parentCommit: 'parent', message: 'm', changes: [{ path: 'a.md', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    const refCalls = fake.requests.filter((r) => r.method === 'PATCH');
    expect(refCalls).toHaveLength(1); // 不重试
    expect((refCalls[0]!.body as { force: boolean }).force).toBe(false);
  });

  it('构造参数校验：令牌与仓库名', () => {
    const base = { token: 't', repo: 'a/b', branch: 'master', fetchImpl: new FakeFetch([]).fetch };
    expect(() => new GithubClient({ ...base, token: '' })).toThrow('缺少访问令牌');
    expect(() => new GithubClient({ ...base, repo: 'justname' })).toThrow('owner/name');
  });
});

/**
 * 分支名写错是最常见的配置失误（main / master 写反），而它的 404 与
 * "令牌没勾这个仓库"的 404 **长得一模一样**。原来只能并列两种可能，
 * 用户得自己猜方向 —— 猜错就会跑去重发令牌，白折腾一轮。
 */
describe('分支 404 的成因判定', () => {
  /**
   * 路由**顺序敏感**：`/repos/owner/repo` 是 `/repos/owner/repo/git/refs/heads`
   * 的子串，先声明它会把分支列表的请求一起吃掉，测试就会诡异地"读不到分支列表"。
   * 所以更具体的路由必须排在前面。
   */
  const branchesRoute = (names: string[]): Route => ({
    match: '/git/refs/heads',
    responses: [{ json: names.map((n) => ({ ref: `refs/heads/${n}` })) }],
  });

  async function refError(routes: Route[]): Promise<GithubError> {
    const { client } = makeClient(routes);
    try {
      await client.getRefHead();
      throw new Error('本应抛错，却成功了');
    } catch (e) {
      if (!(e instanceof GithubError)) throw e;
      return e;
    }
  }

  it('仓库读得到 → 断定是分支写错，并把实际存在的分支列出来', async () => {
    const err = await refError([
      { match: '/git/ref/heads/master', responses: [{ status: 404, text: '{"message":"Not Found"}' }] },
      branchesRoute(['main', 'dev']),
      { match: '/repos/owner/repo', responses: [{ json: { default_branch: 'main' } }] },
    ]);

    expect(err.kind).toBe('not-found');
    expect(err.message).toContain('master'); // 说清是哪个分支不存在
    expect(err.hint).toContain('main'); // 实际存在的分支要列出来
    expect(err.hint).toContain('dev');
    // 别让用户去动本来没问题的东西
    expect(err.hint).toContain('不用动');
    expect(err.hint).not.toContain('两种可能');
  });

  it('仓库也读不到 → 保持「两种可能」，不妄下结论', async () => {
    const err = await refError([
      { match: '/git/ref/heads/master', responses: [{ status: 404, text: '{}' }] },
      { match: '/repos/owner/repo', responses: [{ status: 404, text: '{}' }] },
    ]);

    expect(err.kind).toBe('not-found');
    expect(err.hint).toContain('两种可能');
    expect(err.hint).toContain('令牌');
  });

  it('拿不到分支列表也要给出结论（少一句列举而已）', async () => {
    const err = await refError([
      { match: '/git/ref/heads/master', responses: [{ status: 404, text: '{}' }] },
      { match: '/git/refs/heads', responses: [{ status: 403, text: 'forbidden' }] },
      { match: '/repos/owner/repo', responses: [{ json: { default_branch: 'main' } }] },
    ]);
    expect(err.hint).toContain('分支');
    expect(err.hint).not.toContain('两种可能');
  });

  it('成功路径不受影响：只发一次请求，不做多余的判定', async () => {
    const { client, fake } = makeClient([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'commit1' } } }] },
      { match: '/repos/owner/repo', responses: [{ json: { default_branch: 'main' } }] },
    ]);
    await expect(client.getRefHead()).resolves.toBe('commit1');
    // 判定只该在失败时发生；成功时多打两个请求是白花用户的流量和配额
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toContain('/git/ref/heads/master');
  });

  it('非 404 的失败原样抛出，不被误判成分支问题', async () => {
    const err = await refError([
      { match: '/git/ref/heads/master', responses: [{ status: 500, text: 'boom' }, { status: 500, text: 'boom' }, { status: 500, text: 'boom' }] },
      { match: '/repos/owner/repo', responses: [{ json: { default_branch: 'main' } }] },
    ]);
    expect(err.status).toBe(500);
    expect(err.hint).not.toContain('分支');
  });
});
