/**
 * 虚拟滚动的区间计算（纯函数，便于单测）。
 *
 * 抽屉里可能有上万篇笔记，只渲染可视区 + 少量缓冲，
 * 这样"列表代价与笔记总数无关"这条性能承诺才成立。
 */

export interface WindowInput {
  /** 已滚动的像素。 */
  scrollTop: number;
  /** 可视区高度（像素）。 */
  viewportHeight: number;
  /** 行高（像素，整数）。 */
  rowHeight: number;
  /** 总行数。 */
  total: number;
  /** 上下各多渲染几行，减少快速滚动时的白屏。 */
  overscan?: number;
}

export interface WindowResult {
  /** 起始行下标（含）。 */
  start: number;
  /** 结束行下标（不含）。 */
  end: number;
  /** 撑起滚动条的总高度。 */
  totalHeight: number;
  /** 渲染区在总高度里的偏移。 */
  offsetY: number;
}

export function visibleWindow(input: WindowInput): WindowResult {
  const overscan = input.overscan ?? 6;
  const rowHeight = Math.max(1, Math.floor(input.rowHeight));
  const total = Math.max(0, Math.floor(input.total));
  const totalHeight = total * rowHeight;

  if (total === 0) return { start: 0, end: 0, totalHeight: 0, offsetY: 0 };

  const maxScroll = Math.max(0, totalHeight - input.viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScroll);

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const visibleCount = Math.ceil(input.viewportHeight / rowHeight) + 1;
  const end = Math.min(total, firstVisible + visibleCount + overscan);

  return { start, end, totalHeight, offsetY: start * rowHeight };
}

/** 让某一行滚进可视区（返回新的 scrollTop）。 */
export function scrollToRow(row: number, rowHeight: number, viewportHeight: number, total: number): number {
  const maxScroll = Math.max(0, total * rowHeight - viewportHeight);
  const target = row * rowHeight;
  return Math.min(Math.max(0, target), maxScroll);
}
