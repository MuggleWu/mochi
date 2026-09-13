// @vitest-environment jsdom
/**
 * 外链确认的**端到端**测试：从渲染出来的正文一路点到确认弹层。
 *
 * 为什么要端到端：这条链路由三段拼成（渲染层把 `href` 换成 `data-external`、
 * 阅读态接住点击、App 弹确认），任何一段接错，表现都是"点了链接没反应"或
 * "点了直接跳走"。分段测各自都过、合起来不通，是很容易发生的事。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { App } from './App';
import { useNotes } from './store';

beforeEach(() => {
  useNotes.setState({
    ready: false,
    order: [],
    current: null,
    content: '',
    mode: 'read',
    dirty: false,
    drawerOpen: false,
    ui: { rename: false, sync: false, find: false, menu: false },
    query: '',
    error: null,
    toast: null,
  });
});

/** 打开唯一那篇笔记。 */
const openNote = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(screen.getByLabelText('打开目录'));
  await user.click(await screen.findByText('有链接的笔记'));
  await waitFor(() => expect(useNotes.getState().current).toBe('有链接的笔记.md'));
};

const setup = async () => {
  // 笔记都放在 `notes/` 下 —— 这是应用的目录布局，放根目录扫不到
  const store = new MemoryFileStore({
    'notes/有链接的笔记.md': '正文见[某站](https://example.com/a?b=1)以及[[另一篇]]',
    'notes/另一篇.md': '另一篇的正文',
  });
  render(<App store={store} />);
  const user = userEvent.setup();
  await waitFor(() => expect(useNotes.getState().ready).toBe(true));
  return { user };
};

describe('点正文里的外链', () => {
  it('**不会直接跳走**，而是先弹确认', async () => {
    const { user } = await setup();
    await openNote(user);

    const link = document.querySelector('[data-external]');
    expect(link).toBeTruthy();
    await user.click(link as Element);

    // 弹层出来了，而且地址完整可见
    expect(await screen.findByText('在浏览器里打开？')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/a?b=1')).toBeInTheDocument();
  });

  it('取消之后什么也不会发生，弹层收起', async () => {
    const { user } = await setup();
    await openNote(user);
    await user.click(document.querySelector('[data-external]') as Element);

    await user.click(await screen.findByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByText('在浏览器里打开？')).toBeNull());
    // 阅读位置不该被打断：笔记还开着
    expect(useNotes.getState().current).toBe('有链接的笔记.md');
  });

  it('确认之后才真的打开 —— 而且只打开一次', async () => {
    const { user } = await setup();
    await openNote(user);

    // 兜住"打开"这一步：真的去导航的话 jsdom 会报错，也测不了
    const opened: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement): void {
      if (this.href.startsWith('https://example.com')) {
        opened.push(this.href);
        return;
      }
      realClick.call(this);
    };

    try {
      await user.click(document.querySelector('[data-external]') as Element);
      // 还没确认 —— 一次都不能打开
      expect(opened).toEqual([]);

      await user.click(await screen.findByRole('button', { name: '打开' }));
      expect(opened).toEqual(['https://example.com/a?b=1']);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('内链仍然是内链：点它直接跳，不弹确认', async () => {
    const { user } = await setup();
    await openNote(user);

    await user.click(document.querySelector('[data-wikilink]') as Element);

    expect(screen.queryByText('在浏览器里打开？')).toBeNull();
    await waitFor(() => expect(useNotes.getState().current).toBe('另一篇.md'));
  });

  it('弹层打开时当前正文仍在（弹层是浮层，不是"换页"）', async () => {
    const { user } = await setup();
    await openNote(user);
    await user.click(document.querySelector('[data-external]') as Element);
    await screen.findByText('在浏览器里打开？');
    // 当前笔记没被换掉
    expect(useNotes.getState().current).toBe('有链接的笔记.md');
    expect(document.querySelector('.md')?.textContent).toContain('某站');
  });
});
