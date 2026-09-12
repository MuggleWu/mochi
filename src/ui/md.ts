/**
 * 渲染器的懒加载入口。
 *
 * markdown-it + KaTeX 的 JS 与 KaTeX 的字体加起来体积不小，而首屏（笔记列表）根本用不到
 * 它们。这里做成"用到才加载"，并且 boot 后主动预取 —— 等用户点开某篇笔记时通常已经就位。
 *
 * 未就绪时先按纯文本渲染（与 miki 同款策略）：让用户立刻看到内容，而不是等一个转圈。
 */
import { useEffect, useState } from 'react';
import type { MarkdownRenderer } from '@core/markdown/render';

/** 同一个 Promise 只建一次：多处同时要用时不会重复加载一份几百 KB 的包。 */
let pending: Promise<MarkdownRenderer> | null = null;

export function loadMarkdown(): Promise<MarkdownRenderer> {
  return (pending ??= Promise.all([
    import('@core/markdown/render'),
    // KaTeX 的 CSS 跟着这个懒加载块进来：字体资源有几 MB，放进主包会让首屏白等
    import('katex/dist/katex.min.css'),
  ]).then(([m]) => m.createMarkdownRenderer()));
}

/** 预取渲染管线（应用启动后调用）：用户点开笔记前把它拉下来，避免第一篇闪一下原文。 */
export function prefetchMarkdown(): void {
  void loadMarkdown();
}

/** 渲染器就绪前返回 null，调用方据此走纯文本回退。 */
export function useMarkdownRenderer(): MarkdownRenderer | null {
  const [renderer, setRenderer] = useState<MarkdownRenderer | null>(null);
  useEffect(() => {
    let alive = true;
    void loadMarkdown().then((m) => {
      if (alive) setRenderer(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return renderer;
}
