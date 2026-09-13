/**
 * vitest 全局设置：给 jsdom 用例补上断言扩展与必要的浏览器 API。
 *
 * jsdom 不实现 `ResizeObserver`，而抽屉用它跟踪宽度（`Drawer.tsx`）。真机上它一直存在，
 * 所以这里补个最小替身就够 —— 用例断言的是行为，不需要真的触发回调。
 */
import '@testing-library/jest-dom/vitest';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
