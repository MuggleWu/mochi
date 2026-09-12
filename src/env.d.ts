/// <reference types="vite/client" />

/**
 * KaTeX 的样式表是**按需动态 import** 的（见 ui/md.ts）：它的字体资源有几 MB，
 * 放进主包会让首屏白等，而笔记列表根本用不到公式。
 * Vite 能处理这个 import，但 TS 需要 vite/client 的声明才知道 `.css` 是什么。
 */
