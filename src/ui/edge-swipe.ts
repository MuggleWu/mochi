/**
 * 抽屉手势的判定规则，**纯函数、不碰 DOM**，单独放一个文件是为了能穷举单测。
 *
 * 坐标系约定：偏移是 **0 = 全开，-width = 全收起**（不是 0…width）。
 * 这样它可以直接丢进 `translateX(Npx)`，跟手时也不用再换算方向。
 *
 * 为什么不引现成库：WebView 里没有侧滑抽屉手势，"跟手 + 松手吸附 + 甩动判定"三件事
 * 没法用纯 CSS 表达，自己算反而最少代码。
 */

export interface Point {
  x: number;
  y: number;
}

export interface DragSample extends Point {
  /** 事件时间戳（ms） */
  t: number;
}

/** 起手点必须落在左边这么宽的一条竖带里 —— 再宽就会跟页面内容抢手势。 */
export const EDGE = 28;

/** 位移超过这个量才判定方向，避免手指抖动就把页面滚动变成拉抽屉。 */
export const DIRECTION_SLOP = 6;

/** 横向位移要达到纵向的这么多倍才算"横向拖动"（纵向留给列表滚动）。 */
export const DIRECTION_RATIO = 1.2;

/**
 * 甩动（flick）的速度门槛（px/ms，即 350px/s）。轻扫通常 0.5–2，慢拖通常 < 0.2。
 *
 * 为什么不能只看位置：从收起状态快速往右轻扫 60px 就松手，位置远没到半宽，按位置判定
 * 会被判成"收回原位" —— 用户看到的是"轻轻一滑没用，反而抖回原样"。
 */
export const FLICK_VELOCITY = 0.35;

/** 甩动至少要真的走过这么远，避免手指抖动造成的速度尖峰翻状态。 */
export const FLICK_MIN_DISTANCE = 12;

/** 速度只看最近这段时间的采样，更早的位移不算"甩"。 */
export const VELOCITY_WINDOW = 100;

export type DragAxis = 'horizontal' | 'vertical' | 'none';

/** 起手点是否在左边缘（从关闭状态拉出抽屉的唯一入口）。 */
export function inEdgeZone(x: number): boolean {
  return x <= EDGE;
}

/** 这一下是在横拖还是纵滚。'none' = 还没动够，先不下结论。 */
export function dragAxis(start: Point, now: Point): DragAxis {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  if (Math.abs(dx) < DIRECTION_SLOP && Math.abs(dy) < DIRECTION_SLOP) return 'none';
  return Math.abs(dx) > Math.abs(dy) * DIRECTION_RATIO ? 'horizontal' : 'vertical';
}

/** 从"关闭"开始右拖 dx 时的偏移（clamp 在 [-width, 0]，拖过头也不会把抽屉拉出屏幕）。 */
export function dragOffsetFromClosed(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, -width + dx));
}

/** 从"打开"开始左拖 dx 时的偏移（dx 为负；同样 clamp）。 */
export function dragOffsetFromOpen(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, dx));
}

/** 从采样序列算水平速度（px/ms，正 = 向右）。只取最近 VELOCITY_WINDOW 毫秒。 */
export function dragVelocity(samples: DragSample[]): number {
  if (samples.length < 2) return 0;
  // noUncheckedIndexedAccess 下单元素也是可能 undefined 的，先取出再收窄
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (!s) break;
    if (last.t - s.t > VELOCITY_WINDOW) break;
    first = s;
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
}

/**
 * 松手落点：**先看速度**（甩得够快就按甩的方向），再看位置（过半算打开）。
 * travelled 是按下到松手的横向总位移，用来挡掉"抖一下但速度很大"的误判。
 */
export function shouldSnapOpen(
  offset: number,
  width: number,
  velocity = 0,
  travelled = 0,
): boolean {
  if (travelled >= FLICK_MIN_DISTANCE && Math.abs(velocity) >= FLICK_VELOCITY) {
    return velocity > 0;
  }
  return offset > -width / 2;
}

/** 拖动进度 0…1（0 = 全收起，1 = 全开）。用于遮罩跟手变淡变浓。 */
export function drawerProgress(offset: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(1, 1 + offset / width));
}
