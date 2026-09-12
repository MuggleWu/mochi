import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';
import '@ui/styles.css';

/** 调试开关：在桌面浏览器里复现软键盘占位（与 miki 同款做法）。 */
declare global {
  interface Window {
    __mochiKbOverride?: { height: number; offsetTop?: number };
    /** 模拟"搜索索引尚未就绪"。 */
    __mochiIndexOverride?: boolean;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 容器');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
