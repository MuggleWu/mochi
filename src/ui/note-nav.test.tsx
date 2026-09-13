// @vitest-environment jsdom
/**
 * 上一篇 / 下一篇按钮。
 *
 * 顺序就是列表顺序（最近改的在前），所以「下一篇」在列表里是往更早的方向走 ——
 * 这条容易反，测试里专门钉住。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { NoteNav } from './NoteNav';
import { useNotes } from './store';

const base = useNotes.getState();

beforeEach(() => {
  useNotes.setState({
    ...base,
    ready: false,
    order: [],
    current: null,
    content: '',
    mode: 'read',
    query: '',
    rows: [],
    error: null,
    toast: null,
    drawerOpen: false,
  });
});

afterEach(() => {
  cleanup();
  useNotes.setState(base);
});

/**
 * 起一个真的 store（内存文件层），让 openNote 能真的换篇。
 *
 * 键名要带 `notes/` 前缀：平铺保真存储把笔记放在 `notes/` 下，直接给裸文件名的话
 * 列表是空的（一开始就是这么写错的，表现为按钮压根不渲染）。
 */
async function withNotes(names: string[]): Promise<void> {
  const seed: Record<string, string> = {};
  for (const n of names) seed[`notes/${n}`] = `正文 ${n}`;
  const fs = new MemoryFileStore(seed);
  await useNotes.getState().init(fs);
  // init 之后的顺序由真实排序逻辑给出，这里原样拿来用，正好也是"列表顺序"的定义
}

const btn = (label: string): HTMLButtonElement => screen.getByLabelText(label) as HTMLButtonElement;

describe('阅读态的上一篇 / 下一篇', () => {
  it('有前后邻居时两个键都能按', async () => {
    await withNotes(['甲.md', '乙.md', '丙.md']);
    const order = useNotes.getState().order;
    await useNotes.getState().openNote(order[1]!);
    render(<NoteNav />);
    expect(btn('上一篇').disabled).toBe(false);
    expect(btn('下一篇').disabled).toBe(false);
  });

  it('在第一篇 → 上一篇置灰；在最后一篇 → 下一篇置灰', async () => {
    await withNotes(['甲.md', '乙.md', '丙.md']);
    const order = useNotes.getState().order;

    await useNotes.getState().openNote(order[0]!);
    render(<NoteNav />);
    expect(btn('上一篇').disabled).toBe(true);
    expect(btn('下一篇').disabled).toBe(false);

    cleanup();
    await useNotes.getState().openNote(order[order.length - 1]!);
    render(<NoteNav />);
    expect(btn('下一篇').disabled).toBe(true);
    expect(btn('上一篇').disabled).toBe(false);
  });

  it('点右箭头走的是列表里的下一篇（不是把顺序搞反）', async () => {
    await withNotes(['甲.md', '乙.md', '丙.md']);
    const order = useNotes.getState().order;
    await useNotes.getState().openNote(order[0]!);
    render(<NoteNav />);

    btn('下一篇').click();
    // openNote 里有真的文件 IO，手动刷 microtask 不够，等状态到位
    await waitFor(() => expect(useNotes.getState().current).toBe(order[1]));
  });

  it('编辑态不显示（那两个位置要留给文字本身）', async () => {
    await withNotes(['甲.md', '乙.md']);
    await useNotes.getState().openNote(useNotes.getState().order[0]!);
    useNotes.setState({ mode: 'edit' });
    render(<NoteNav />);
    expect(screen.queryByLabelText('上一篇')).toBeNull();
  });

  it('没打开任何笔记时不显示', () => {
    render(<NoteNav />);
    expect(screen.queryByLabelText('上一篇')).toBeNull();
  });
});
