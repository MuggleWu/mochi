/**
 * M1 元数据拉取的端到端自测（假网络 + 内存文件层）。
 *
 * 验收标准：配置好仓库后点一次同步，抽屉里就出现远端全部笔记（按修改时间倒序），
 * 而且**一篇内容都没下载**。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { MANIFEST_FILE } from '@core/fs/layout';
import { FakeFetch } from '@core/net/fake-fetch';
import { FLAG, deserializeMeta } from '@core/sync/manifest';
import { useNotes, __setFetchForTest } from './store';

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

const treeFake = (entries: Array<Record<string, unknown>>) =>
  new FakeFetch([
    { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
    { match: '/git/commits/c1', responses: [{ json: { sha: 'c1', tree: { sha: 't1' } } }] },
    { match: '/git/trees/t1', responses: [{ json: { sha: 't1', truncated: false, tree: entries } }] },
  ]);

const blob = (path: string, size = 100): Record<string, unknown> => ({
  path,
  mode: '100644',
  type: 'blob',
  sha: `sha-${path}`,
  size,
});

beforeEach(() => {
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
  it('三个请求拿到全部笔记，列表按修改时间倒序，且没下载任何内容', async () => {
    const fake = treeFake([blob('甲笔记.md', 10), blob('乙笔记.md', 20), blob('丙笔记.md', 30)]);
    __setFetchForTest(fake.fetch);
    const fs = new MemoryFileStore();

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });
    await useNotes.getState().pullMetadata();

    const s = useNotes.getState();
    expect(s.error).toBeNull();
    expect(s.order).toHaveLength(3);
    expect(s.order.sort()).toEqual(['丙笔记.md', '乙笔记.md', '甲笔记.md']);
    expect(s.lastSyncNote).toContain('3 篇');
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET']);

    // 关键：没有任何 blob 请求（内容一篇都没下载）
    expect(fake.count('/git/blobs/')).toBe(0);

    // 清单已落盘，且条目带「仅元数据」标记
    const persisted = deserializeMeta((await fs.readText(MANIFEST_FILE))!);
    expect(persisted.lastCommit).toBe('c1');
    expect(persisted.lastTree).toBe('t1');
    expect(persisted.notes['甲笔记.md']!.flags & FLAG.METADATA_ONLY).toBe(FLAG.METADATA_ONLY);
    expect(fs.snapshot().some((f) => f.startsWith('notes/'))).toBe(false); // notes/ 下什么都没有
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

  it('重复同步是幂等的，第二次仍只有 3 个请求', async () => {
    const fake = treeFake([blob('a.md'), blob('b.md')]);
    __setFetchForTest(fake.fetch);

    useNotes.setState({ ready: false, order: [] });
    await useNotes.getState().init(new MemoryFileStore());
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'tok' });

    await useNotes.getState().pullMetadata();
    await useNotes.getState().pullMetadata();

    expect(fake.requests).toHaveLength(6); // 每次 3 个
    expect(useNotes.getState().order).toHaveLength(2);
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
