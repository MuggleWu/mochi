/**
 * 状态机端到端自测（不需要真机、不需要界面）。
 *
 * 覆盖：首次启动建清单 → 新建 → 编辑保存 → 改名 → 删除 → 重启后清单仍在。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { MANIFEST_FILE } from '@core/fs/layout';
import { deserializeMeta, FLAG } from '@core/sync/manifest';
import { useNotes } from './store';

/** 清空 zustand 状态，回到"刚启动"的样子。 */
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
  });
};

const fresh = async (): Promise<MemoryFileStore> => {
  const fs = new MemoryFileStore();
  resetState();
  await useNotes.getState().init(fs);
  return fs;
};

/** 模拟"本地已经有笔记的首次启动"：文件先落盘，再建清单。 */
const freshWith = async (seed: Record<string, string>): Promise<MemoryFileStore> => {
  const fs = new MemoryFileStore(seed);
  resetState();
  await useNotes.getState().init(fs);
  return fs;
};

describe('启动与清单', () => {
  it('首次启动会建立清单并落盘', async () => {
    const fs = await fresh();
    const s = useNotes.getState();
    expect(s.ready).toBe(true);
    expect(s.order).toEqual([]);
    const raw = await fs.readText(MANIFEST_FILE);
    expect(raw).not.toBeNull();
    expect(deserializeMeta(raw!).schemaVersion).toBe(1);
  });

  it('启动时若本地已有笔记，清单包含它们并按修改时间倒序', async () => {
    // MemoryFileStore 按写入顺序递增 mtime，后写的更新
    await freshWith({ 'notes/旧.md': '旧', 'notes/新.md': '新' });
    expect(useNotes.getState().order).toEqual(['新.md', '旧.md']);
  });

  it('清单损坏时不崩溃，而是从磁盘重建', async () => {
    await freshWith({ 'notes/有内容.md': '正文', [MANIFEST_FILE]: '{ 这不是合法 json' });
    const s = useNotes.getState();
    expect(s.ready).toBe(true);
    expect(s.order).toEqual(['有内容.md']);
    expect(s.meta.notes['有内容.md']!.localSha).toHaveLength(40);
  });
});

describe('新建 / 编辑 / 保存', () => {
  let fs: MemoryFileStore;
  beforeEach(async () => {
    fs = await fresh();
  });

  it('新建笔记直接进入编辑态', async () => {
    await useNotes.getState().createNote();
    const s = useNotes.getState();
    expect(s.current).toBe('未命名.md');
    expect(s.mode).toBe('edit');
    expect(s.dirty).toBe(true);
    expect(s.order).toContain('未命名.md');
  });

  it('编辑并保存后：内容落盘、sha 更新、脏标记清掉', async () => {
    await useNotes.getState().createNote();
    useNotes.getState().setContent('# 第一行标题\n正文内容');
    expect(useNotes.getState().dirty).toBe(true);

    await useNotes.getState().saveNote();
    const s = useNotes.getState();
    expect(s.dirty).toBe(false);

    const entry = s.meta.notes['未命名.md']!;
    expect(entry.localSha).toHaveLength(40);
    expect(entry.flags & FLAG.DIRTY).toBe(FLAG.DIRTY); // 待推送
    expect(await fs.readText('notes/未命名.md')).toBe('# 第一行标题\n正文内容');

    // 清单已同步落盘
    const persisted = deserializeMeta((await fs.readText(MANIFEST_FILE))!);
    expect(persisted.notes['未命名.md']!.localSha).toBe(entry.localSha);
  });

  it('保存后再次打开能读回同样内容', async () => {
    await useNotes.getState().createNote();
    useNotes.getState().setContent('内容 A');
    await useNotes.getState().saveNote();
    useNotes.setState({ current: null, content: '' });

    await useNotes.getState().openNote('未命名.md');
    expect(useNotes.getState().content).toBe('内容 A');
    expect(useNotes.getState().mode).toBe('read');
  });

  it('打开不存在的笔记给提示而不是崩溃', async () => {
    await useNotes.getState().openNote('不存在.md');
    expect(useNotes.getState().error).toContain('不存在.md');
    expect(useNotes.getState().current).toBeNull();
  });
});

describe('重命名与删除', () => {
  it('重命名：清单条目跟着搬，旧名消失', async () => {
    const fs = await fresh();
    await useNotes.getState().createNote();
    useNotes.getState().setContent('要改名的内容');
    await useNotes.getState().saveNote();

    await useNotes.getState().renameNote('改名后的标题.md');
    const s = useNotes.getState();
    expect(s.current).toBe('改名后的标题.md');
    expect(s.meta.notes['改名后的标题.md']).toBeTruthy();
    expect(s.meta.notes['未命名.md']).toBeUndefined();
    expect(await fs.exists('notes/未命名.md')).toBe(false);
    expect(await fs.readText('notes/改名后的标题.md')).toBe('要改名的内容');
  });

  it('删除：从清单与磁盘移除，内容留在回收站', async () => {
    const fs = await fresh();
    await useNotes.getState().createNote();
    useNotes.getState().setContent('别丢了我');
    await useNotes.getState().saveNote();

    await useNotes.getState().deleteNote();
    const s = useNotes.getState();
    expect(s.current).toBeNull();
    expect(s.meta.notes['未命名.md']).toBeUndefined();
    expect(await fs.exists('notes/未命名.md')).toBe(false);
    expect(await fs.readText('trash/未命名.md')).toBe('别丢了我');
  });
});

describe('搜索', () => {
  it('文件名命中最先出，只走内存不读文件', async () => {
    await freshWith({
      'notes/读书笔记.md': 'x',
      'notes/会议记录.md': 'x',
      'notes/读后感想.md': 'x',
    });

    const pending = useNotes.getState().setSearchQuery('读');
    // 文件名那段是同步 set 的，await 之前就该能读到（这是"敲字即有反馈"的保证）
    const hits = useNotes.getState().visible();
    expect([...hits].sort()).toEqual(['读后感想.md', '读书笔记.md'].sort());
    await pending;
  });

  it('查询为空时退回全量清单，而不是空列表', async () => {
    await freshWith({ 'notes/a.md': 'x', 'notes/b.md': 'y' });
    await useNotes.getState().setSearchQuery('   ');
    expect(useNotes.getState().visible().sort()).toEqual(['a.md', 'b.md']);
    expect(useNotes.getState().rows).toEqual([]);
  });
});

describe('读写态切换的位置保持', () => {
  it('比例被记住', async () => {
    await useNotes.getState().createNote();
    useNotes.getState().setScrollRatio(0.42);
    useNotes.getState().setMode('read');
    expect(useNotes.getState().scrollRatio).toBeCloseTo(0.42);
  });
});
