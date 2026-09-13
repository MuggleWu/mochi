// @vitest-environment jsdom
/**
 * 抽屉手势**接线层**的测试：真的派发触摸事件，看 store 有没有跟着动。
 *
 * 为什么单有 `edge-swipe.test.ts` 不够：那层测的是纯函数（方向、速度、吸附），
 * 而咬过人的 bug 在接线处 —— "编辑态直接 `return`"，纯函数全绿、手势却完全不响应。
 * 这一层就是专门盯"某个状态下 hook 压根不接事件"这类问题。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EDGE } from './edge-swipe';
import { useEdgeSwipe } from './useEdgeSwipe';
import { useNotes } from './store';

const base = useNotes.getState();

/** 挂一个只跑 hook 的组件，拿到真实的 document 级监听。 */
function Harness(): null {
  useEdgeSwipe();
  return null;
}

function touch(type: string, x: number, y: number, target?: Element): void {
  const t = { clientX: x, clientY: y, identifier: 1, target: target ?? document.body };
  const list = type === 'touchend' || type === 'touchcancel' ? [] : [t];
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  Object.defineProperty(ev, 'touches', { value: list });
  Object.defineProperty(ev, 'changedTouches', { value: [t] });
  (target ?? document).dispatchEvent(ev);
}

/** 从起点拖到终点（中间补几帧，速度判定才有样本）。 */
function drag(from: number, to: number, y = 400): void {
  touch('touchstart', from, y);
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    touch('touchmove', from + ((to - from) * i) / steps, y);
  }
  touch('touchend', to, y);
}

beforeEach(() => {
  useNotes.setState({ ...base, drawerOpen: false, drawerOffset: null, mode: 'read' });
});

afterEach(() => {
  cleanup();
  useNotes.setState(base);
});

describe('抽屉手势：什么状态下会接管', () => {
  it('阅读态从左缘拖 → 抽屉跟着动', () => {
    render(<Harness />);
    drag(2, 120);
    expect(useNotes.getState().drawerOffset).not.toBeNull();
  });

  it('**编辑态也要能从左缘拉出抽屉**（真机反馈：编辑态滑不出来）', () => {
    // 曾经的实现是"编辑态直接不接管"，理由怕抢了文字选择 —— 但编辑时恰恰最常需要
    // 滑出抽屉换一篇，而那一下就落在正文左缘，结果就是"编辑态抽屉打不开"。
    useNotes.setState({ mode: 'edit' });
    render(<Harness />);
    drag(2, 120);
    expect(useNotes.getState().drawerOffset).not.toBeNull();
  });

  it('编辑态在最左缘之外开始拖 → 不接管（把正文留给文字选择）', () => {
    useNotes.setState({ mode: 'edit' });
    render(<Harness />);
    drag(EDGE + 60, EDGE + 240);
    expect(useNotes.getState().drawerOffset).toBeNull();
  });

  it('阅读态在最左缘之外开始拖 → 同样不接管', () => {
    render(<Harness />);
    drag(EDGE + 60, EDGE + 240);
    expect(useNotes.getState().drawerOffset).toBeNull();
  });

  it('纵向拖动让位给页面滚动（不接管）', () => {
    render(<Harness />);
    touch('touchstart', 2, 400);
    for (let i = 1; i <= 5; i++) touch('touchmove', 3, 400 + i * 20);
    touch('touchend', 3, 500);
    expect(useNotes.getState().drawerOffset).toBeNull();
  });

  it('弹层开着时不接管（免得两层手势打架）', () => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    document.body.appendChild(sheet);
    try {
      render(<Harness />);
      drag(2, 120);
      expect(useNotes.getState().drawerOffset).toBeNull();
    } finally {
      sheet.remove();
    }
  });
});
