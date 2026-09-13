/**
 * 「回来时还跟离开前一样」的端到端自测。
 *
 * 场景来自用户的真实抱怨：切回 mochi 又得重新打开一篇。
 *
 * 这里用的手段是**换一个 store 实例读同一个文件层**，也就是真的"关掉应用再打开"，
 * 而不是在同一份内存状态里假装重启 —— 后者根本测不出落盘有没有做对。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { MANIFEST_FILE, SESSION_FILE } from '@core/fs/layout';
import { deserializeSession } from '@core/fs/session';
import { deserializeMeta, serializeMeta } from '@core/sync/manifest';
import { useNotes } from './store';

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
    ui: { rename: false, sync: false, find: false, menu: false, selfCheck: false },
    query: '',
    scrollRatio: 0,
    error: null,
    toast: null,
  });
};

/** 第一次启动：本地已有这些笔记。 */
const firstRun = async (seed: Record<string, string> = {}): Promise<MemoryFileStore> => {
  const fs = new MemoryFileStore(seed);
  resetState();
  await useNotes.getState().init(fs);
  return fs;
};

/** 再打开一次应用：同一个磁盘、全新的内存状态。 */
const relaunch = async (fs: MemoryFileStore): Promise<void> => {
  resetState();
  await useNotes.getState().init(fs);
};

/** 等搜索词的防抖写入落地（比防抖时长稍长一点）。 */
const waitQuerySaved = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 600));

beforeEach(() => resetState());

describe('重新打开应用后回到离开时的样子', () => {
  it('离开前开着哪篇，回来还是那篇（含正文）', async () => {
    const fs = await firstRun({ 'notes/会议记录.md': '今天定了三件事' });
    await useNotes.getState().openNote('会议记录.md');
    expect(useNotes.getState().current).toBe('会议记录.md');

    await useNotes.getState().saveSession();
    await relaunch(fs);

    const s = useNotes.getState();
    expect(s.current).toBe('会议记录.md');
    expect(s.content).toBe('今天定了三件事'); // 正文也回来了，不用再读一次盘
  });

  it('阅读位置、编辑/阅读态、搜索词都跟着回来', async () => {
    const fs = await firstRun({ 'notes/长文.md': '很长的一篇' });
    await useNotes.getState().openNote('长文.md');
    useNotes.getState().setScrollRatio(0.62);
    useNotes.getState().setSearchQuery('长');
    await useNotes.getState().saveSession();

    await relaunch(fs);
    const s = useNotes.getState();
    expect(s.scrollRatio).toBe(0.62);
    expect(s.query).toBe('长');
    expect(s.current).toBe('长文.md');
  });

  it('**光敲搜索词、不切后台**，重开也还在（真机反馈：之前搜的词和结果都没了）', async () => {
    // 这条与上一条的区别是要害所在：上一条手动调了 `saveSession()`，等于替应用把活干了，
    // 所以它测的只是"会话文件能装下搜索词"，测不出"搜索词会不会自己被存下来"。
    // 真实路径是：用户敲完词就把应用杀了 —— 没有任何时机去调 saveSession()。
    // 所以这里刻意**不调** saveSession()，只等自动落盘，然后重启。
    const fs = await firstRun({ 'notes/甲.md': '橘子' });
    useNotes.getState().setSearchQuery('橘子');
    // 等自动落盘那一刻过去。这里用真定时器：全局开假定时器会把别的用例里
    // 依赖真定时器的路径一起拖死（试过，连带 4 条用例超时）。
    await waitQuerySaved();
    await relaunch(fs);
    expect(useNotes.getState().query).toBe('橘子');
  });

  it('关键词落盘不会把会话里的其他状态覆盖成旧的', async () => {
    // 防抖写入与 saveSession() 是两条写入路径，若防抖那次晚于 saveSession() 落地，
    // 它带的是敲字当时的 query，会把刚写的会话整个盖回去。saveSession() 里取消挂起写入就是为了这个。
    const fs = await firstRun({ 'notes/甲.md': '橘子' });
    await useNotes.getState().openNote('甲.md');
    useNotes.getState().setSearchQuery('橘');
    // 敲完立刻写一次完整会话（模拟"这时切后台了"）
    await useNotes.getState().saveSession();
    useNotes.getState().setSearchQuery('橘子');
    await useNotes.getState().saveSession();
    // 再等一会儿：被取消的那次不该把 '橘' 盖回来
    await waitQuerySaved();
    await relaunch(fs);
    const s = useNotes.getState();
    expect(s.query).toBe('橘子');
    expect(s.current).toBe('甲.md');
  });

  it('写着字切出去、回来接着写：未保存的内容不丢', async () => {
    const fs = await firstRun({ 'notes/草稿.md': '原来的开头' });
    await useNotes.getState().openNote('草稿.md');
    await useNotes.getState().setMode('edit');
    useNotes.getState().setContent('原来的开头，又写了一段还没保存的');

    await useNotes.getState().saveSession(); // 模拟切后台
    await relaunch(fs);

    const s = useNotes.getState();
    expect(s.current).toBe('草稿.md');
    expect(s.content).toBe('原来的开头，又写了一段还没保存的');
    expect(s.dirty).toBe(true); // 记住它**还没保存**，不能当成已保存
    expect(s.mode).toBe('edit');
  });

  it('没有未保存改动时不写草稿（阅读态来回滚动不该碰磁盘）', async () => {
    const fs = await firstRun({ 'notes/只有内容.md': '正文' });
    await useNotes.getState().openNote('只有内容.md');
    useNotes.getState().setScrollRatio(0.3);
    await useNotes.getState().saveSession();

    const saved = deserializeSession(await fs.readText(SESSION_FILE));
    expect(saved.draft).toBeNull();
    expect(saved.scrollRatio).toBe(0.3);
  });
});

describe('状态指向失效的笔记时要降级，不能硬还原', () => {
  it('那篇笔记在电脑上被删了 → 回到空态，不留一个指向不存在路径的状态', async () => {
    const fs = await firstRun({ 'notes/会被删掉.md': '内容' });
    await useNotes.getState().openNote('会被删掉.md');
    await useNotes.getState().saveSession();

    // 模拟"电脑上删掉后同步下来"：清单里没有它了，磁盘上的文件也没了。
    // 必须改**磁盘上的清单**，只改内存测不出东西 —— init 会用磁盘那份重建状态。
    const diskMeta = deserializeMeta((await fs.readText(MANIFEST_FILE))!);
    delete diskMeta.notes['会被删掉.md'];
    await fs.writeText(MANIFEST_FILE, serializeMeta(diskMeta));
    await fs.remove('notes/会被删掉.md');

    await relaunch(fs);
    expect(useNotes.getState().current).toBeNull();
    expect(useNotes.getState().content).toBe('');
  });

  it('状态文件坏了 → 正常启动，只是没回到上次的样子', async () => {
    const fs = await firstRun({ 'notes/a.md': 'x' });
    await useNotes.getState().openNote('a.md');
    await fs.writeText(SESSION_FILE, '{ 坏掉的 json');

    await relaunch(fs); // 不该抛错
    expect(useNotes.getState().ready).toBe(true);
    expect(useNotes.getState().current).toBeNull();
  });

  it('删除当前笔记后，状态里不留它（下次不会打开一篇已删的）', async () => {
    const fs = await firstRun({ 'notes/要删.md': '内容' });
    await useNotes.getState().openNote('要删.md');
    await useNotes.getState().deleteNote();
    await new Promise((r) => setTimeout(r, 0)); // 让内部那次异步落盘跑完

    await relaunch(fs);
    expect(useNotes.getState().current).toBeNull();
  });

  it('重命名后状态跟着搬到新路径', async () => {
    const fs = await firstRun({ 'notes/旧名.md': '内容' });
    await useNotes.getState().openNote('旧名.md');
    await useNotes.getState().renameNote('新名.md');
    await new Promise((r) => setTimeout(r, 0));

    await relaunch(fs);
    expect(useNotes.getState().current).toBe('新名.md');
    expect(useNotes.getState().content).toBe('内容');
  });
});

describe('抽屉不要盖住回来的笔记', () => {
  it('离开时抽屉开着，回来是关的（用户要看的是笔记）', async () => {
    const fs = await firstRun({ 'notes/笔记.md': 'x' });
    await useNotes.getState().openNote('笔记.md');
    useNotes.getState().setDrawer(true);
    await useNotes.getState().saveSession();

    await relaunch(fs);
    expect(useNotes.getState().current).toBe('笔记.md');
    expect(useNotes.getState().drawerOpen).toBe(false);
  });
});

describe('状态写入的时机（只靠切后台那一次是不够的）', () => {
  it('打开一篇笔记后，即使从没切过后台，状态也已经落盘', async () => {
    // 依据：Android 给 onPause 写完磁盘的窗口很短，异步写入可能没落完。
    // 所以"打开就记一次"是必需的，不能只在切后台时才写。
    const fs = await firstRun({ 'notes/开着的.md': '内容' });
    await useNotes.getState().openNote('开着的.md');
    await new Promise((r) => setTimeout(r, 0)); // 让内部那次异步落盘跑完

    // 直接看磁盘：不经过任何"切后台"调用
    const saved = deserializeSession(await fs.readText(SESSION_FILE));
    expect(saved.current).toBe('开着的.md');
  });

  it('切换阅读/编辑态后会落盘', async () => {
    const fs = await firstRun({ 'notes/切态.md': '内容' });
    await useNotes.getState().openNote('切态.md');
    await new Promise((r) => setTimeout(r, 0));
    await useNotes.getState().setMode('edit');
    await new Promise((r) => setTimeout(r, 0));

    const saved = deserializeSession(await fs.readText(SESSION_FILE));
    expect(saved.mode).toBe('edit');
  });

  it('滚动位置变了但内容没变时，状态里也不带草稿（读盘不该写正文）', async () => {
    const fs = await firstRun({ 'notes/读着.md': '内容' });
    await useNotes.getState().openNote('读着.md');
    useNotes.getState().setScrollRatio(0.8);
    await useNotes.getState().saveSession();

    const saved = deserializeSession(await fs.readText(SESSION_FILE));
    expect(saved.scrollRatio).toBe(0.8);
    expect(saved.draft).toBeNull();
  });
});
