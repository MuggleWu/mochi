/**
 * 抽屉手势判定层的单测。
 *
 * 把这些规则抽成纯函数就是为了能这样穷举 —— 手感问题在真机上试一次要装一次包，
 * 而"纵向退让""慢拖后快甩""快速轻扫只来两个事件"这几种情形在这里几毫秒就能钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SLOP,
  EDGE,
  dragAxis,
  dragOffsetFromClosed,
  dragOffsetFromOpen,
  dragVelocity,
  drawerProgress,
  inEdgeZone,
  shouldSnapOpen,
  type DragSample,
} from './edge-swipe';

const W = 300; // 抽屉宽度

describe('inEdgeZone', () => {
  it('只有左边缘那条竖带里才算起手', () => {
    expect(inEdgeZone(0)).toBe(true);
    expect(inEdgeZone(EDGE)).toBe(true);
    expect(inEdgeZone(EDGE + 1)).toBe(false);
    expect(inEdgeZone(200)).toBe(false);
  });
});

describe('dragAxis', () => {
  const start = { x: 10, y: 400 };

  it('没动够之前不下结论（避免手指抖动就改判）', () => {
    expect(dragAxis(start, { x: 10, y: 400 })).toBe('none');
    expect(dragAxis(start, { x: 12, y: 401 })).toBe('none');
    expect(dragAxis(start, { x: 10 + DIRECTION_SLOP - 1, y: 400 })).toBe('none');
  });

  it('横向要明显大于纵向才算横拖（纵向留给列表滚动）', () => {
    // 1.2 倍是门槛：dx=24 / dy=20 → 24 > 24 不成立，判纵
    expect(dragAxis(start, { x: 34, y: 420 })).toBe('vertical');
    // dx=30 / dy=20 → 30 > 24 成立，判横
    expect(dragAxis(start, { x: 40, y: 420 })).toBe('horizontal');
  });

  it('纯纵向一定是纵滚', () => {
    expect(dragAxis(start, { x: 10, y: 500 })).toBe('vertical');
    expect(dragAxis(start, { x: 12, y: 500 })).toBe('vertical');
  });
});

describe('拖动偏移', () => {
  it('从关闭右拖：起手是 -width，拖满 width 才到 0', () => {
    expect(dragOffsetFromClosed(0, W)).toBe(-W);
    expect(dragOffsetFromClosed(150, W)).toBe(-150);
    expect(dragOffsetFromClosed(W, W)).toBe(0);
  });

  it('拖过头会被夹住，不会把抽屉拉出屏幕或反向超开', () => {
    expect(dragOffsetFromClosed(-500, W)).toBe(-W);
    expect(dragOffsetFromClosed(W + 500, W)).toBe(0);
  });

  it('从打开左拖：起手是 0，往左变负', () => {
    expect(dragOffsetFromOpen(0, W)).toBe(0);
    expect(dragOffsetFromOpen(-150, W)).toBe(-150);
    expect(dragOffsetFromOpen(-W, W)).toBe(-W);
  });

  it('从打开右拖不会超过全开', () => {
    expect(dragOffsetFromOpen(120, W)).toBe(0);
    expect(dragOffsetFromOpen(-9999, W)).toBe(-W);
  });
});

describe('dragVelocity（只看最近 100ms 的滑窗）', () => {
  const sample = (x: number, t: number): DragSample => ({ x, y: 0, t });

  it('采样不足时是 0', () => {
    expect(dragVelocity([])).toBe(0);
    expect(dragVelocity([sample(0, 0)])).toBe(0);
  });

  it('同刻采样不会除以零', () => {
    expect(dragVelocity([sample(0, 100), sample(50, 100)])).toBe(0);
  });

  it('匀速右拖得出正速度', () => {
    // 100ms 走了 100px → 1 px/ms
    expect(dragVelocity([sample(0, 0), sample(50, 50), sample(100, 100)])).toBeCloseTo(1, 5);
  });

  it('慢拖很久再快甩：速度只反映最后那一段（这正是滑窗存在的理由）', () => {
    // 前 400ms 慢慢挪 40px（0.1 px/ms），最后 50ms 猛地甩 100px（2 px/ms）
    const samples = [
      sample(0, 0),
      sample(10, 100),
      sample(20, 200),
      sample(30, 300),
      sample(40, 400),
      sample(140, 450),
    ];
    const v = dragVelocity(samples);
    // 全段平均只有 140/450 ≈ 0.31，会被拖慢到甩动门槛以下；滑窗算出来是 2
    expect(v).toBeCloseTo(2, 5);
    expect(v).toBeGreaterThan(0.35);
  });

  it('窗口外的旧采样不参与', () => {
    const samples = [sample(0, 0), sample(1000, 10), sample(1010, 200)];
    // 最后一段是 10px/190ms，中间那段早超出 100ms 窗口
    const v = dragVelocity(samples);
    expect(v).toBeLessThan(0.1);
  });
});

describe('shouldSnapOpen（先看速度，再看位置）', () => {
  it('没速度时按位置：过半开、不过半关', () => {
    expect(shouldSnapOpen(-W / 2 + 1, W)).toBe(true); // 略过半 → 开
    expect(shouldSnapOpen(-W / 2, W)).toBe(false); // 正正好一半 → 关
    expect(shouldSnapOpen(-W + 10, W)).toBe(false); // 几乎没收起 → 关
  });

  it('轻扫到位就按方向定，与拖了多远无关（这是"轻轻一滑没反应"的修复）', () => {
    // 只拖了 60px（远没到半宽 150），但速度够快 → 打开
    expect(shouldSnapOpen(-W + 60, W, 1.2, 60)).toBe(true);
    // 反向同理：从打开只左滑 60px，快速甩 → 关闭
    expect(shouldSnapOpen(-60, W, -1.2, 60)).toBe(false);
  });

  it('速度够快但根本没走过距离时不认（挡掉抖动造成的速度尖峰）', () => {
    // travelled=5 < FLICK_MIN_DISTANCE=12 → 退回位置判定
    expect(shouldSnapOpen(-W + 5, W, 5, 5)).toBe(false);
  });

  it('速度没到门槛时仍然按位置', () => {
    expect(shouldSnapOpen(-W + 60, W, 0.2, 60)).toBe(false);
  });
});

describe('drawerProgress（遮罩跟手）', () => {
  it('全收起是 0、全开是 1，中间线性', () => {
    expect(drawerProgress(-W, W)).toBe(0);
    expect(drawerProgress(-W / 2, W)).toBeCloseTo(0.5, 5);
    expect(drawerProgress(0, W)).toBe(1);
  });

  it('超出范围会被夹住', () => {
    expect(drawerProgress(-W - 500, W)).toBe(0);
    expect(drawerProgress(500, W)).toBe(1);
  });

  it('宽度未知时返回 0 而不是 NaN', () => {
    expect(drawerProgress(-100, 0)).toBe(0);
  });
});
