/**
 * GitHub 客户端单测（全部离线，用假 fetch）。
 *
 * 重点是失败路径：超时、限流重试、404 的歧义提示、非快进冲突、推送只发 3 个请求。
 */
import { describe, expect, it } from 'vitest';
import { FakeFetch } from './fake-fetch';
import { GithubClient, GithubError, explainFailure, rootMarkdownFiles } from './github';
import { isNoteName } from '../paths';

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

  it('限流会重试，成功即返回', async () => {
    const { client, fake } = makeClient([
      {
        match: '/git/ref/heads/master',
        responses: [
          { status: 403, text: 'API rate limit exceeded', headers: { 'retry-after': '0' } },
          { json: { object: { sha: 'ok' } } },
        ],
      },
    ]);
    expect(await client.getRefHead()).toBe('ok');
    expect(fake.count('/git/ref')).toBe(2);
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
