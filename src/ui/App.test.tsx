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
    // 弹层状态不重置的话，上一个用例开着的查找栏/弹层会带进下一个用例
    ui: { rename: false, sync: false, find: false, menu: false, selfCheck: false },
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

/**
 * 查找与替换。
 *
 * 走真实点击链路：顶栏「查找」→ 输入 → 计数 → 上一个/下一个 → （编辑态）替换。
 */
describe('查找与替换', () => {
  /** 造一篇有内容的笔记并回到阅读态。 */
  async function writeNote(user: ReturnType<typeof userEvent.setup>, text: string) {
    await waitFor(() => expect(screen.getByText(/打开笔记/)).toBeInTheDocument());
    await user.click(screen.getByLabelText('打开目录'));
    await user.click(screen.getByText('＋ 新建笔记'));
    await user.type(await screen.findByPlaceholderText('在这里写点什么…'), text);
    await user.click(screen.getByLabelText('进入阅读'));
  }

  it('阅读态：能打开查找栏，输入后显示命中计数', async () => {
    const { user } = setup();
    await writeNote(user, '供应链管理与供应链优化');

    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '供应链');

    // 阅读态的计数以 DOM 里实际标出来的为准。渲染管线是懒加载的：正文先按纯文本
    // 顶上，模块就绪后换成 HTML、这时才打得上标记，所以这里必须 waitFor。
    await waitFor(() => expect(screen.getByText(/^1 \/ 2$/)).toBeInTheDocument());
    expect(document.querySelectorAll('mark[data-find]').length).toBe(2);
    expect(document.querySelectorAll('mark[data-find-current]').length).toBe(1);
  });

  it('阅读态：下一个会循环回到第一处', async () => {
    const { user } = setup();
    await writeNote(user, '甲\n甲\n甲');
    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '甲');
    await waitFor(() => expect(screen.getByText(/^1 \/ 3$/)).toBeInTheDocument());

    await user.click(screen.getByLabelText('下一个'));
    expect(screen.getByText(/^2 \/ 3$/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('下一个'));
    expect(screen.getByText(/^3 \/ 3$/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('下一个'));
    // 循环，而不是卡在最后一处
    expect(screen.getByText(/^1 \/ 3$/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('上一个'));
    expect(screen.getByText(/^3 \/ 3$/)).toBeInTheDocument();
  });

  it('没有命中时明说，而不是显示 0/0', async () => {
    const { user } = setup();
    await writeNote(user, '只有这一句');
    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '不存在的词');
    await waitFor(() => expect(screen.getByText('没有匹配')).toBeInTheDocument());
  });

  it('编辑态：多出替换行，能替换当前一处', async () => {
    const { user, store } = setup();
    // 两处分在不同行：替换必须跨行正确（只改命中的那几个字符，不能动换行）
    await writeNote(user, '苹果和苹果\n第二行');
    await user.click(screen.getByLabelText('进入编辑'));

    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '苹果');
    await waitFor(() => expect(screen.getByText(/^1 \/ 2$/)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('替换为…'), '橘子');
    await user.click(screen.getByText('替换'));

    // 只剩一处「苹果」了
    await waitFor(() => expect(screen.getByText(/^1 \/ 1$/)).toBeInTheDocument());
    await user.click(screen.getByLabelText('进入阅读'));
    await waitFor(async () => expect(await store.readText('notes/未命名.md')).toBe('橘子和苹果\n第二行'));
  });

  it('编辑态：全部替换', async () => {
    const { user, store } = setup();
    await writeNote(user, '苹果和苹果和苹果');
    await user.click(screen.getByLabelText('进入编辑'));

    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '苹果');
    await waitFor(() => expect(screen.getByText(/^1 \/ 3$/)).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('替换为…'), '梨');
    await user.click(screen.getByText('全部替换'));

    await waitFor(() => expect(screen.getByText('没有匹配')).toBeInTheDocument());
    await user.click(screen.getByLabelText('进入阅读'));
    await waitFor(async () => expect(await store.readText('notes/未命名.md')).toBe('梨和梨和梨'));
  });

  it('替换串里的 $ 按字面量写进去（不会变成"整个匹配"）', async () => {
    const { user, store } = setup();
    await writeNote(user, '价格 X 元');
    await user.click(screen.getByLabelText('进入编辑'));
    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), 'X');
    await waitFor(() => expect(screen.getByText(/^1 \/ 1$/)).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('替换为…'), '$&100');
    await user.click(screen.getByText('替换'));
    await user.click(screen.getByLabelText('进入阅读'));

    // 若用了 String.replaceAll，这里会变成"价格 X100 元"
    await waitFor(async () => expect(await store.readText('notes/未命名.md')).toBe('价格 $&100 元'));
  });

  it('关闭查找会清掉高亮', async () => {
    const { user } = setup();
    await writeNote(user, '测试文本');
    await user.click(screen.getByTitle(/查找/));
    await user.type(screen.getByPlaceholderText('查找…'), '测试');
    await waitFor(() => expect(document.querySelectorAll('mark[data-find]').length).toBe(1));

    await user.click(screen.getByLabelText('关闭查找'));
    await waitFor(() => expect(document.querySelectorAll('mark[data-find]').length).toBe(0));
    expect(screen.queryByPlaceholderText('查找…')).not.toBeInTheDocument();
  });
});
