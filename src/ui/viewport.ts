/**
 * 键盘挡住内容这件事，网页侧怎么算。
 *
 * 背景：Android 15+ 起 targetSdk 35+ 强制边到边，窗口不再随输入法收缩，
 * `windowSoftInputMode="adjustResize"` 在边到边窗口上等于失效 —— 键盘是**画在内容之上**的。
 *
 * 真机上还有一层原生兜底：MainActivity 按输入法内边距给 **WebView 自己**加底部外边距
 * （它真的变短，滚动与定位都自然跟着走），键盘让位主要由那一层负责。原生撑短之后，
 * 这里的布局视口与可见区一起变小，算出来自然接近 0 —— 两边不会叠加，也不需要额外的信号协调。
 *
 * 那为什么还要这一层：Android 14 及以下 + 老 WebView 那一格，原生拿不到输入法内边距，
 * 这里是唯一的让位来源。
 */
export interface ViewportMetrics {
  /** 布局视口高度（documentElement.clientHeight） */
  layoutHeight: number;
  /** 可见视口高度（visualViewport.height）：键盘弹起时变小 */
  visualHeight: number;
  /** 可见区在布局坐标里的上沿（visualViewport.offsetTop） */
  visualOffsetTop: number;
  /** 缩放（visualViewport.scale）：非 1 时可见高度要按布局坐标折算 */
  scale: number;
}

/** 键盘最多占屏幕的比例。超过它一定是量错了（比如把缩放算错）。 */
const MAX_KEYBOARD_RATIO = 0.7;

/**
 * 键盘占掉的高度（CSS 像素，>= 0）。
 *
 * 公式是「布局视口底 − 可见区底」，可见区底要 **乘上缩放再加 offsetTop**：
 * offsetTop 是可见区在布局坐标里的上沿（浏览器为露出输入框把可视区往下滚过就有值），
 * 只减 height 会算出一个假的键盘高度。
 */
export function keyboardHeight(m: ViewportMetrics): number {
  const scale = m.scale > 0 ? m.scale : 1;
  const visibleBottom = m.visualHeight * scale + m.visualOffsetTop;
  const raw = m.layoutHeight - visibleBottom;
  const max = m.layoutHeight * MAX_KEYBOARD_RATIO;
  return Math.round(Math.min(Math.max(raw, 0), max));
}

interface VisualViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

function readMetrics(): ViewportMetrics {
  const vv = window.visualViewport as unknown as VisualViewportLike | undefined;
  const override = window.__mochiKbOverride;
  const layoutHeight = document.documentElement.clientHeight;
  return {
    layoutHeight,
    visualHeight: override?.height ?? vv?.height ?? layoutHeight,
    visualOffsetTop: override?.offsetTop ?? vv?.offsetTop ?? 0,
    scale: vv?.scale ?? 1,
  };
}

/**
 * 开始盯键盘高度：立刻算一次，并在可视区尺寸/位置变化时重算。返回取消函数。
 */
export function watchKeyboardHeight(onChange: (height: number) => void): () => void {
  const vv = window.visualViewport as unknown as VisualViewportLike | undefined;
  // 没有可视视口信息（老 WebView）时**不写**这个变量：CSS 里的默认值就是 0，
  // 写了反而会把上一次的高度留在一个说不准的页面上。
  if (!vv) return () => {};

  let last = -1;
  const apply = (): void => {
    const kb = keyboardHeight(readMetrics());
    if (kb === last) return;
    last = kb;
    onChange(kb);
  };

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // 原生改 CSS 变量不产生可视区事件，它改完会派发这个事件（见 MainActivity 注入的脚本）。
  const onNativeInsets = (): void => apply();
  window.addEventListener('mochi:insets', onNativeInsets);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    window.removeEventListener('mochi:insets', onNativeInsets);
  };
}
