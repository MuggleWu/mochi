// @vitest-environment jsdom
/**
 * 顶栏「更多」菜单的界面测试：走真实点击链路。
 *
 * 重点是**复制出去的内容对不对**（这是功能的价值），以及没有内容时不能假装成功。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setClipboardForTest } from '@core/clipboard';
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
    ui: { rename: false, sync: false, find: false, menu: false, selfCheck: false },
    query: '',
    error: null,
    toast: null,
  });
});

afterEach(() => __setClipboardForTest(null));

const setup = async () => {
  const store = new MemoryFileStore({ 'notes/会议记录.md': '今天定了三件事' });
  render(<App store={store} />);
  const user = userEvent.setup();
  await waitFor(() => expect(useNotes.getState().ready).toBe(true));
  return { store, user };
};

/** 打开唯一那篇笔记（本地已有内容，不走网络）。 */
const openNote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByLabelText('打开目录'));
  await user.click(await screen.findByText('会议记录'));
  await waitFor(() => expect(useNotes.getState().current).toBe('会议记录.md'));
};

describe('顶栏「更多」菜单', () => {
  it('三个竖点在同步按钮右边，点开有复制项，再点收起', async () => {
    const { user } = await setup();
    const more = screen.getByLabelText('更多操作');
    expect(more).toBeInTheDocument();
    expect(more).toHaveTextContent('⋮');

    // 必须在同步按钮**之后**（即它右边）——用文档顺序判断，不依赖具体布局数值
    const sync = screen.getByTitle(/同步设置与拉取/);
    expect(sync.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(more);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('复制当前笔记')).toBeInTheDocument();

    await user.click(more);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('竖点必须带 menu-toggle 类（否则菜单开着时它自己被遮罩盖住，再点收不起来）', async () => {
    // 这条是真浏览器里抓出来的：jsdom 没有命中测试，遮罩压住按钮照样"点得到"，
    // 所以只能靠钉住类名 —— 类丢了，那个 bug 就会原样回来。
    const { user } = await setup();
    const more = screen.getByLabelText('更多操作');
    expect(more).toHaveClass('menu-toggle');
    await user.click(more);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    // 遮罩必须存在（"点别处收起"靠它），且按钮要能压过它
    expect(document.querySelector('.menu-scrim')).toBeTruthy();
  });

  it('点菜单以外的地方会收起（不挡着下面的内容）', async () => {
    const { user } = await setup();
    await user.click(screen.getByLabelText('更多操作'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    await user.click(document.querySelector('.menu-scrim') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('复制当前笔记：标题补在前面，写进剪贴板并给出反馈', async () => {
    const written: string[] = [];
    __setClipboardForTest(async (text) => {
      written.push(text);
    });

    const { user } = await setup();
    await openNote(user);
    await user.click(screen.getByLabelText('更多操作'));
    await user.click(screen.getByText('复制当前笔记'));

    await waitFor(() => expect(written).toEqual(['# 会议记录\n\n今天定了三件事']));
    // 复制完就收起菜单并告诉用户成功了（不反馈的话用户会怀疑到底复制上没有）
    expect(await screen.findByText(/已复制/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('可以只要正文，不要标题', async () => {
    const written: string[] = [];
    __setClipboardForTest(async (text) => {
      written.push(text);
    });

    const { user } = await setup();
    await openNote(user);
    await user.click(screen.getByLabelText('更多操作'));
    await user.click(screen.getByText('复制当前笔记（不含标题）'));

    await waitFor(() => expect(written).toEqual(['今天定了三件事']));
  });

  it('复制失败必须说出来，不能假装成功', async () => {
    __setClipboardForTest(async () => {
      throw new Error('系统剪贴板不可用');
    });

    const { user } = await setup();
    await openNote(user);
    await user.click(screen.getByLabelText('更多操作'));
    await user.click(screen.getByText('复制当前笔记'));

    expect(await screen.findByText(/复制失败/)).toBeInTheDocument();
    expect(screen.queryByText(/已复制/)).not.toBeInTheDocument();
  });

  it('没有打开笔记时，复制项是禁用的', async () => {
    const written: string[] = [];
    __setClipboardForTest(async (text) => {
      written.push(text);
    });

    const { user } = await setup();
    await user.click(screen.getByLabelText('更多操作'));
    const item = screen.getByText('复制当前笔记').closest('button')!;
    expect(item).toBeDisabled();
    await user.click(item);
    expect(written).toEqual([]);
  });
});
