/**
 * 元数据拉取的单测：只发 3 个请求就能拿到全部笔记的清单。
 */
import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../net/fake-fetch';
import { GithubClient } from '../net/github';
import { FLAG, emptyMeta, type Meta } from './manifest';
import { fetchSnapshot, reconcileSnapshot } from './pull-metadata';

const client = (routes: ConstructorParameters<typeof FakeFetch>[0]) => {
  const fake = new FakeFetch(routes);
  return {
    fake,
    github: new GithubClient({
      token: 'tok',
      repo: 'owner/repo',
      branch: 'master',
      fetchImpl: fake.fetch,
      backoffMs: () => 0,
      maxRetryDelayMs: 0,
    }),
  };
};

const treeRoutes = (entries: Array<Record<string, unknown>>) => [
  { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
  { match: '/git/commits/c1', responses: [{ json: { sha: 'c1', tree: { sha: 't1' } } }] },
  { match: '/git/trees/t1', responses: [{ json: { sha: 't1', truncated: false, tree: entries } }] },
];

const blob = (path: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  path,
  mode: '100644',
  type: 'blob',
  sha: `sha-${path}`,
  size: 100,
  ...extra,
});

describe('fetchSnapshot', () => {
  it('只用 3 个请求取回根目录 markdown 全表', async () => {
    const { github, fake } = client(
      treeRoutes([
        blob('读书笔记.md'),
        blob('会议记录.md'),
        blob('.obsidian/app.json'),
        blob('sub/嵌套.md'),
        { path: 'images', mode: '040000', type: 'tree', sha: 'tree-img' },
      ]),
    );

    const snap = await fetchSnapshot(github);
    expect(fake.requests).toHaveLength(3);
    expect(snap.commitSha).toBe('c1');
    expect(snap.treeSha).toBe('t1');
    expect(snap.files.map((f) => f.path)).toEqual(['读书笔记.md', '会议记录.md']);
    expect(snap.files[0]!.sha).toBe('sha-读书笔记.md');
  });

  it('空仓库得到空列表（不报错）', async () => {
    const { github } = client(treeRoutes([]));
    const snap = await fetchSnapshot(github);
    expect(snap.files).toEqual([]);
  });
});

describe('reconcileSnapshot', () => {
  const snap = (files: Array<{ path: string; sha: string; size: number }>, commit = 'c1', tree = 't1') => ({
    commitSha: commit,
    treeSha: tree,
    files,
  });

  it('远端新笔记进清单，标记为「仅元数据」', () => {
    const meta = emptyMeta('owner/repo');
    const next = reconcileSnapshot(meta, snap([{ path: '新笔记.md', sha: 's1', size: 120 }]), 1000);

    const entry = next.notes['新笔记.md']!;
    expect(entry.remoteSha).toBe('s1');
    expect(entry.localSha).toBe('');
    expect(entry.syncedSha).toBe('');
    expect(entry.size).toBe(120);
    expect(entry.flags & FLAG.METADATA_ONLY).toBe(FLAG.METADATA_ONLY);
    expect(next.lastCommit).toBe('c1');
    expect(next.lastTree).toBe('t1');
    expect(next.lastSyncAt).toBe(1000);
  });

  it('已有条目只更新远端 sha，不动本地记账', () => {
    const meta = emptyMeta('owner/repo');
    meta.notes['a.md'] = { path: 'a.md', localSha: 'L', remoteSha: 'old', syncedSha: 'old', size: 50, mtime: 5, flags: 0 };
    const next = reconcileSnapshot(meta, snap([{ path: 'a.md', sha: 'new', size: 60 }]));

    const entry = next.notes['a.md']!;
    expect(entry.remoteSha).toBe('new');
    expect(entry.localSha).toBe('L');
    expect(entry.syncedSha).toBe('old'); // 基准不动，等真正的同步判定
    expect(entry.mtime).toBe(5); // 不覆盖本地修改时间
  });

  it('远端已消失的笔记被标记 REMOTE_DELETED，内容不动', () => {
    const meta = emptyMeta('owner/repo');
    meta.notes['删了.md'] = { path: '删了.md', localSha: 'L', remoteSha: 'r', syncedSha: 'r', size: 10, mtime: 1, flags: 0 };
    const next = reconcileSnapshot(meta, snap([]));

    const entry = next.notes['删了.md']!;
    expect(entry.remoteSha).toBe('');
    expect(entry.localSha).toBe('L');
    expect(entry.flags & FLAG.REMOTE_DELETED).toBe(FLAG.REMOTE_DELETED);
  });

  it('从不存在的路径不会被误标为已删（本地新建、还没推上去）', () => {
    const meta = emptyMeta('owner/repo');
    meta.notes['本地新建.md'] = { path: '本地新建.md', localSha: 'L', remoteSha: '', syncedSha: '', size: 10, mtime: 1, flags: FLAG.DIRTY };
    const next = reconcileSnapshot(meta, snap([]));
    expect(next.notes['本地新建.md']!.flags).toBe(FLAG.DIRTY);
  });

  it('连续两次同步结果稳定（幂等）', () => {
    const meta = emptyMeta('owner/repo');
    const files = [
      { path: 'a.md', sha: 's1', size: 1 },
      { path: 'b.md', sha: 's2', size: 2 },
    ];
    const once = reconcileSnapshot(meta, snap(files), 1000);
    const twice = reconcileSnapshot(once, snap(files), 2000);
    expect(twice.notes).toEqual(once.notes);
    expect(twice.lastSyncAt).toBe(2000);
  });

  it('规模：一万篇笔记也能在一次调用内并入清单', () => {
    const meta: Meta = emptyMeta('owner/repo');
    const files = Array.from({ length: 10_000 }, (_, i) => ({ path: `笔记-${i}.md`, sha: `sha${i}`, size: i }));
    const next = reconcileSnapshot(meta, snap(files, 'c9', 't9'));
    expect(Object.keys(next.notes)).toHaveLength(10_000);
    expect(next.notes['笔记-9999.md']!.remoteSha).toBe('sha9999');
  });
});
