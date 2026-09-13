// @vitest-environment jsdom
/**
 * 外链确认弹层的界面测试：走真实点击链路。
 *
 * 要钉住的是"**只有确认之后才打开**"这件事。这条一旦失效，表现是"点了链接直接跳走"，
 * 而手机上从浏览器切回来要重新找位置 —— 用户会以为是误触，不会想到是代码问题。
 * 所以三个方向都要测：取消不打开、确认才打开、以及地址要看得到。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalLinkConfirm } from './ExternalLinkConfirm';

afterEach(cleanup);

describe('外链确认', () => {
  it('没有待确认地址时什么都不渲染', () => {
    render(<ExternalLinkConfirm url="" onClose={() => undefined} open={() => undefined} />);
    expect(screen.queryByText('在浏览器里打开？')).toBeNull();
  });

  it('**取消：一次都不打开**', async () => {
    const open = vi.fn();
    render(<ExternalLinkConfirm url="https://example.com/a" onClose={() => undefined} open={open} />);
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(open).not.toHaveBeenCalled();
  });

  it('确认后才打开，且地址原样传出去', async () => {
    const open = vi.fn();
    render(<ExternalLinkConfirm url="https://example.com/a?b=1" onClose={() => undefined} open={open} />);
    await userEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/a?b=1');
  });

  it('确认后要关掉弹层，否则用户被留在原地', async () => {
    const onClose = vi.fn();
    render(<ExternalLinkConfirm url="https://example.com/a" onClose={onClose} open={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('完整地址要显示出来 —— 链接文字常是"这里"，看不出要去哪', async () => {
    render(
      <ExternalLinkConfirm
        url="https://example.com/very/long/path?token=abc"
        onClose={() => undefined}
        open={() => undefined}
      />,
    );
    expect(screen.getByText('https://example.com/very/long/path?token=abc')).toBeTruthy();
    // 顺带把域名单独报一句，让人一眼知道要去哪（只断言那一行，完整地址里也有域名）
    expect(screen.getByText(/跳到\s*example\.com/)).toBeTruthy();
  });

  it('连点两下不会打开两次', async () => {
    const open = vi.fn();
    render(<ExternalLinkConfirm url="https://example.com/a" onClose={() => undefined} open={open} />);
    const btn = screen.getByRole('button', { name: '打开' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('点弹层外面等于取消，不打开', async () => {
    const open = vi.fn();
    const { container } = render(
      <ExternalLinkConfirm url="https://example.com/a" onClose={() => undefined} open={open} />,
    );
    const scrim = container.querySelector('.scrim');
    expect(scrim).toBeTruthy();
    await userEvent.click(scrim as Element);
    expect(open).not.toHaveBeenCalled();
  });
});
