/**
 * vitest 全局设置：给用例补上断言扩展与必要的浏览器 API。
 *
 * 补的这些在真机上一直存在，只是测试环境（jsdom / node）没有。补的时候只求"够用"：
 * 用例断言的是行为，不需要它们真的做动画或测量布局。
 */
import '@testing-library/jest-dom/vitest';

/** jsdom 不实现 `ResizeObserver`，而抽屉用它跟踪宽度（`Drawer.tsx`）。 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

/**
 * node 环境里没有 `requestAnimationFrame`，而 `setDrawer` 用它等一帧再播入场动画。
 * 用定时器顶上，语义等价（下一轮事件循环）。
 */
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => clearTimeout(id)) as typeof cancelAnimationFrame;
}
