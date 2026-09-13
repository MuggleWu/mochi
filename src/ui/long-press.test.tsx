// @vitest-environment jsdom
/**
 * 长按的测试。
 *
 * 这个交互有两个容易搞错的地方，搞错了在真机上很难查（用户只会觉得"按钮坏了"）：
 * 一是**滚动时误触**（手机上按住手抖是常态），二是**长按之后又触发一次短按**
 * （同步按钮上就是长按打开了诊断页、抬手又弹同步面板）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LONG_PRESS_MS, MOVE_TOLERANCE, useLongPress } from './long-press';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function Probe({ onLongPress, onTap }: { onLongPress: () => void; onTap: () => void }): React.JSX.Element {
  const handlers = useLongPress(onLongPress, onTap);
  return (
    <button type="button" {...handlers}>
      按我
    </button>
  );
}

describe('长按', () => {
  /*
   * 用 `fireEvent` 直接派发指针事件，不用 `userEvent`：后者自带一套等待与推进逻辑，
   * 和假定时器凑在一起会互相等，表现是每条用例都跑到超时才失败（踩过）。
   * 这里要验的就是"时间到了会怎样"，所以时间必须完全由自己掌控。
   */
  const down = (el: Element, x = 0, y = 0): void => {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0 });
  };
  const move = (el: Element, x: number, y: number): void => {
    fireEvent.pointerMove(el, { clientX: x, clientY: y });
  };

  it('按住够久 → 触发长按', () => {
    const onLongPress = vi.fn();
    const onTap = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={onTap} />);

    down(screen.getByRole('button'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('**长按之后抬手不再触发短按**（否则会连带打开另一个面板）', () => {
    const onLongPress = vi.fn();
    const onTap = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={onTap} />);

    const btn = screen.getByRole('button');
    down(btn);
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('普通点击 → 触发短按，不触发长按', () => {
    const onLongPress = vi.fn();
    const onTap = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={onTap} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('**手指移开（在滚动）→ 取消长按**', () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={vi.fn()} />);

    const btn = screen.getByRole('button');
    down(btn, 0, 0);
    move(btn, 200, 200); // 远超容差
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('移动在容差内仍然算长按（手抖不该取消）', () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={vi.fn()} />);

    const btn = screen.getByRole('button');
    down(btn, 100, 100);
    move(btn, 100 + MOVE_TOLERANCE - 1, 100 + MOVE_TOLERANCE - 1); // 容差以内
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('长按时间没到就抬手 → 不触发长按', () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={vi.fn()} />);

    const btn = screen.getByRole('button');
    down(btn);
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    fireEvent.pointerUp(btn);
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('取消（系统打断）也不触发长按', () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} onTap={vi.fn()} />);

    const btn = screen.getByRole('button');
    down(btn);
    fireEvent.pointerCancel(btn);
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
