// @vitest-environment jsdom
/**
 * 诊断页的测试。
 *
 * 这一页的价值全在"数字对不对、该标的标出来"。所以重点不是"能不能打开"，而是：
 * 核心状态确实显示、对不上的篇目确实列出来、**令牌不能被显示出来**（这一页可能会被
 * 截图发出去）、以及出错时有地方可去。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { FLAG, type NoteEntry } from '@core/sync/manifest';
import { App } from './App';
import { SelfCheckPage } from './SelfCheckPage';
import { useNotes } from './store';

const entry = (path: string, over: Partial<NoteEntry> = {}): NoteEntry => ({
  path,
  localSha: 'l',
  remoteSha: 'r',
  syncedSha: 'r',
  size: 3,
  mtime: 0,
  fileMtime: 0,
  flags: 0,
  ...over,
});

/** 备一个已经初始化过的文件层（诊断页要读目录）。 */
async function initStore(files: Record<string, string>): Promise<MemoryFileStore> {
  const store = new MemoryFileStore(files);
  await useNotes.getState().init(store);
  return store;
}

beforeEach(() => {
  useNotes.setState({
    ready: false,
    order: [],
    current: null,
    content: '',
    mode: 'read',
    dirty: false,
    drawerOpen: false,
    ui: { rename: false, sync: false, find: false, menu: false, selfCheck: false },
    query: '',
    error: null,
    toast: null,
    meta: { ...useNotes.getState().meta, notes: {}, conflicts: [], lastCommit: '' },
    pushDirty: 0,
    conflicts: [],
    pendingContent: 0,
    indexed: 0,
    indexing: false,
    pullStage: '',
    lastSyncNote: '',
    histNote: '',
  });
});

afterEach(cleanup);

describe('诊断页', () => {
  it('把核心状态显示出来：篇数、待下载、索引、上次提交', async () => {
    // **清单交给 store 自己算**（`init` 会扫描文件层），不硬塞。
    // 硬塞的清单一旦和磁盘不一致，测的就是一个不存在的世界 —— 踩过。
    await initStore({ 'notes/甲.md': 'abc', 'notes/乙.md': 'abc' });
    useNotes.setState({ indexed: 2, meta: { ...useNotes.getState().meta, lastCommit: 'abcdef1234567890' } });

    render(<SelfCheckPage onClose={() => undefined} />);

    expect(screen.getByText('诊断')).toBeInTheDocument();
    // 自检是异步跑的，先等它数完
    await waitFor(() => expect(screen.getByText(/清单和磁盘对得上/)).toBeInTheDocument());
    // 篇数：清单 2 篇、本地有内容 2 篇
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('abcdef123456')).toBeInTheDocument(); // 提交只显示前 12 位
    expect(screen.getByText('2 篇')).toBeInTheDocument(); // 已索引
  });

  it('**令牌只报有没有，绝不显示内容**（这一页可能被截图）', async () => {
    await initStore({ 'notes/甲.md': 'abc' });
    useNotes.setState({
      settings: { repo: 'owner/repo', branch: 'master', token: 'github_pat_SECRET123' },
    });

    render(<SelfCheckPage onClose={() => undefined} />);

    expect(screen.getByText('已填写')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET123/)).toBeNull();
    // 连片段都不该出现
    expect(document.body.textContent).not.toContain('github_pat');
  });

  it('清单和磁盘对不上时列出来，并说清楚是哪一种', async () => {
    // 磁盘上两份，清单里只有一份 → 一份"磁盘有、清单没有"
    await initStore({ 'notes/甲.md': 'abc', 'notes/多出来的.md': 'abc' });
    const notes = { ...useNotes.getState().meta.notes };
    delete notes['多出来的.md'];
    // 再塞一份清单里有、磁盘没有的
    useNotes.setState({ meta: { ...useNotes.getState().meta, notes: { ...notes, '缺少的.md': entry('缺少的.md') } } });

    render(<SelfCheckPage onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText('清单与磁盘对不上')).toBeInTheDocument(), { timeout: 3000 });
    // "N 篇"这种文案在页面上有好几处，只认跟在对不上那一项后面的那个
    expect(screen.getByText('清单与磁盘对不上').nextElementSibling).toHaveTextContent('2 篇');
    expect(screen.getByText(/清单说有、磁盘没有/)).toBeInTheDocument();
    expect(screen.getByText(/磁盘有、清单没有/)).toBeInTheDocument();
  });

  it('待推送与待决冲突分别报出来', async () => {
    await initStore({ 'notes/甲.md': 'abc' });
    const notes = useNotes.getState().meta.notes;
    useNotes.setState({
      meta: {
        ...useNotes.getState().meta,
        notes: { '甲.md': { ...(notes['甲.md'] ?? entry('甲.md')), flags: FLAG.DIRTY } },
      },
      pushDirty: 1,
      conflicts: [{ path: '甲.md', localSha: 'l', remoteSha: 'r', syncedSha: 'b' }],
    });

    render(<SelfCheckPage onClose={() => undefined} />);

    // 只断言标签在（"1 篇"会同时出现在待推送和待决冲突两行，按标签定位更准）
    expect(screen.getByText('待推送')).toBeInTheDocument();
    expect(screen.getByText('待决冲突')).toBeInTheDocument();
    expect(screen.getAllByText('1 篇')).toHaveLength(2);
  });

  it('上次错误显示出来（没有就说没有）', async () => {
    await initStore({ 'notes/甲.md': 'abc' });
    render(<SelfCheckPage onClose={() => undefined} />);
    expect(screen.getByText('没有记录到错误')).toBeInTheDocument();

    cleanup();
    useNotes.setState({ error: '推送失败：网络不通' });
    render(<SelfCheckPage onClose={() => undefined} />);
    expect(screen.getByText('推送失败：网络不通')).toBeInTheDocument();
  });

  it('自检本身跑不动时要明说，不能装作没问题', async () => {
    // 没初始化过文件层 → `list` 会抛
    /*
     * 先用真实的文件层把清单建好（这样界面上的数字是正常的），再换成"只有 `list` 会失败"
     * 的代理 —— 要验的是自检**读不到目录时敢不敢说自己出错了**。
     *
     * 不能用 `{...store}` 造替身：MemoryFileStore 的方法在原型上，展开拿不到，
     * 表现是 `this.store.ensureDir is not a function`（踩过）。用代理只换掉 `list`。
     */
    const real = new MemoryFileStore({ 'notes/甲.md': 'abc' });
    await useNotes.getState().init(real);
    const broken = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'list') return () => Promise.reject(new Error('目录读不了'));
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    // 直接换掉模块里的文件层（`getStore()` 会拿到它）
    await useNotes.getState().init(broken);

    render(<SelfCheckPage onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText(/自检跑不动/)).toBeInTheDocument());
  });

  it('点关闭能关掉', async () => {
    await initStore({ 'notes/甲.md': 'abc' });
    let closed = false;
    render(
      <SelfCheckPage
        onClose={() => {
          closed = true;
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(closed).toBe(true);
  });
});

describe('诊断页的入口', () => {
  it('长按顶栏同步按钮打开诊断页；短按仍然打开同步面板', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc' });
    render(<App store={store} />);
    await waitFor(() => expect(useNotes.getState().ready).toBe(true));

    const sync = screen.getByTitle(/同步设置与拉取/);

    // 短按 → 同步面板
    await userEvent.click(sync);
    expect(useNotes.getState().ui.sync).toBe(true);
    useNotes.getState().setUi('sync', false);

    // 长按 → 诊断页（用真实计时器等过阈值，事件是真的派发下去的）
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.pointerDown(sync, { clientX: 0, clientY: 0, button: 0 });
    await waitFor(() => expect(useNotes.getState().ui.selfCheck).toBe(true), { timeout: 2000 });
    expect(useNotes.getState().ui.sync).toBe(false);
  });

  it('**出错时能一键进诊断页** —— 否则错误文案里那句"请查看诊断页"无处可去', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc' });
    render(<App store={store} />);
    await waitFor(() => expect(useNotes.getState().ready).toBe(true));

    useNotes.setState({ error: '建树结果里没有 sha\n重试一次；若持续失败请查看诊断页。' });
    const btn = await screen.findByRole('button', { name: '诊断' });
    await userEvent.click(btn);

    expect(useNotes.getState().ui.selfCheck).toBe(true);
    // 用页面独有的"关闭"按钮认它开了（"诊断"这个词在错误条的按钮上也有）
    expect(await screen.findByRole('button', { name: '关闭' })).toBeInTheDocument();
  });
});
