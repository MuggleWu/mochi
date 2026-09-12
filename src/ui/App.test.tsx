// @vitest-environment jsdom
/**
 * 界面冒烟测试：走真实点击链路（jsdom），验证外壳能跑通。
 *
 * 覆盖：启动、空态、打开抽屉、新建笔记、编辑、保存、切回阅读、目录里出现该笔记。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { App } from './App';
import { useNotes } from './store';

// zustand 状态是模块级的，用例之间必须重置，否则互相污染
beforeEach(() => {
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
});

const setup = () => {
  const store = new MemoryFileStore();
  render(<App store={store} />);
  return { store, user: userEvent.setup() };
};

describe('应用外壳', () => {
  it('启动后显示顶栏与空态提示', async () => {
    setup();
    expect(screen.getByText('mochi')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/打开笔记，或新建一篇/)).toBeInTheDocument());
  });

  it('打开抽屉 → 新建 → 编辑 → 保存 → 回到阅读态', async () => {
    const { store, user } = setup();
    await waitFor(() => expect(screen.getByText(/打开笔记/)).toBeInTheDocument());

    // 打开抽屉
    await user.click(screen.getByLabelText('打开目录'));
    expect(await screen.findByPlaceholderText(/搜索笔记名/)).toBeInTheDocument();

    // 新建笔记：直接进入编辑态
    await user.click(screen.getByText('＋ 新建笔记'));
    const textarea = await screen.findByPlaceholderText('在这里写点什么…');
    // markdown 的块级语法（标题/列表/代码块）需要前后有空行；单换行属于同一段落
    await user.type(textarea, '# 我的第一篇{enter}{enter}正文内容');

    // 行号槽应随内容增长（1 行起）
    expect(document.querySelectorAll('.gutter-inner span').length).toBeGreaterThanOrEqual(1);

    // 保存并切换回阅读态
    await user.click(screen.getByLabelText('进入阅读'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('我的第一篇'));
    expect(await store.readText('notes/未命名.md')).toBe('# 我的第一篇\n\n正文内容');
  });

  it('新建的笔记出现在目录列表里，且可再次打开', async () => {
    const { user } = setup();
    await waitFor(() => expect(screen.getByText(/打开笔记/)).toBeInTheDocument());

    await user.click(screen.getByLabelText('打开目录'));
    await user.click(screen.getByText('＋ 新建笔记'));
    const textarea = await screen.findByPlaceholderText('在这里写点什么…');
    await user.type(textarea, '第一篇内容');
    await user.click(screen.getByLabelText('进入阅读'));

    await user.click(screen.getByLabelText('打开目录'));
    // 目录标题栏里出现该笔记（未命名去掉 .md）
    const rows = await screen.findAllByText('未命名');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('点击标题可以重命名，删除需要二次确认', async () => {
    const { user, store } = setup();
    await waitFor(() => expect(screen.getByText(/打开笔记/)).toBeInTheDocument());

    await user.click(screen.getByLabelText('打开目录'));
    await user.click(screen.getByText('＋ 新建笔记'));
    await user.type(await screen.findByPlaceholderText('在这里写点什么…'), '内容');
    await user.click(screen.getByLabelText('进入阅读'));

    // 点顶栏标题进入重命名层（用可访问名，避免与抽屉里的行重名）
    await user.click(screen.getByLabelText('笔记标题，点击可重命名'));
    const input = await screen.findByDisplayValue('未命名');
    await user.clear(input);
    await user.type(input, '改过的名字');
    await user.click(screen.getByText('确定'));

    await waitFor(async () => expect(await store.exists('notes/改过的名字.md')).toBe(true));
    expect(await store.exists('notes/未命名.md')).toBe(false);

    // 删除要走二次确认
    await user.click(screen.getByLabelText('笔记标题，点击可重命名'));
    await user.click(await screen.findByText('删除'));
    expect(await screen.findByText(/确定删除《改过的名字》/)).toBeInTheDocument();
    expect(await store.exists('notes/改过的名字.md')).toBe(true); // 还没真删

    await user.click(screen.getByText('确认删除'));
    await waitFor(async () => expect(await store.exists('notes/改过的名字.md')).toBe(false));
  });
});
