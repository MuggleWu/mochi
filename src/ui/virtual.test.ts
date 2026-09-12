import { describe, expect, it } from 'vitest';
import { scrollToRow, visibleWindow } from './virtual';

describe('visibleWindow', () => {
  it('顶部：从 0 开始，渲染可视行数 + 上下缓冲', () => {
    const w = visibleWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 40, total: 1000, overscan: 2 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(1 + 10 + 2); // 可视 10 行 + 1 + 缓冲 2
    expect(w.totalHeight).toBe(40_000);
    expect(w.offsetY).toBe(0);
  });

  it('中部：起始行随滚动推进', () => {
    const w = visibleWindow({ scrollTop: 4_000, viewportHeight: 400, rowHeight: 40, total: 1000, overscan: 2 });
    expect(w.start).toBe(98); // 第 100 行减缓冲 2
    expect(w.end).toBe(100 + 10 + 1 + 2);
    expect(w.offsetY).toBe(98 * 40);
  });

  it('底部：不超过总数', () => {
    const w = visibleWindow({ scrollTop: 39_900, viewportHeight: 400, rowHeight: 40, total: 1000, overscan: 2 });
    expect(w.end).toBe(1000);
    expect(w.start).toBeGreaterThan(900);
  });

  it('空列表与零高度不炸', () => {
    expect(visibleWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 40, total: 0 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
      offsetY: 0,
    });
    const w = visibleWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: 40, total: 10 });
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThanOrEqual(10);
  });

  it('一万篇时也只渲染几十行（性能承诺）', () => {
    const w = visibleWindow({ scrollTop: 100_000, viewportHeight: 800, rowHeight: 56, total: 10_070 });
    expect(w.end - w.start).toBeLessThan(40);
  });

  it('负数与超范围滚动被夹住', () => {
    expect(visibleWindow({ scrollTop: -100, viewportHeight: 400, rowHeight: 40, total: 10 }).start).toBe(0);
    const w = visibleWindow({ scrollTop: 1e9, viewportHeight: 400, rowHeight: 40, total: 10 });
    expect(w.end).toBe(10);
  });
});

describe('scrollToRow', () => {
  it('把目标行顶到可视区顶部，并夹在合法范围', () => {
    expect(scrollToRow(10, 40, 400, 1000)).toBe(400);
    expect(scrollToRow(0, 40, 400, 1000)).toBe(0);
    expect(scrollToRow(999, 40, 400, 1000)).toBe(39_600); // 夹到最大滚动位置
    expect(scrollToRow(-5, 40, 400, 1000)).toBe(0);
  });
});
