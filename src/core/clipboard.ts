/**
 * 剪贴板写入。
 *
 * 为什么不用 `navigator.clipboard.writeText`：Android WebView 里它要么不存在，要么
 * 因为安全上下文/权限被静默拒绝 —— 表现是"点了复制、粘贴出来什么都没有"，这种失败
 * 最难查。Capacitor 插件走的是原生剪贴板，稳定得多。
 *
 * 浏览器里（开发与端到端自测）没有 Capacitor 桥，退回 `navigator.clipboard`，
 * 再退回老式的 `execCommand('copy')`（虽然废弃，但它是仅剩的同步兜底）。
 */

import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';

/** 只给测试用：替换真实写入。 */
let impl: ((text: string) => Promise<void>) | null = null;

/** 只给测试用：注入替身（传 null 恢复真实实现）。 */
export function __setClipboardForTest(next: ((text: string) => Promise<void>) | null): void {
  impl = next;
}

/** 老式兜底：临时塞一个不可见的 textarea 选中后复制。 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.createElement('textarea');
  el.value = text;
  // 放在屏幕外，避免闪一下；同时禁止键盘弹出与滚动跳动
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.top = '-1000px';
  el.style.opacity = '0';
  document.body.appendChild(el);
  try {
    el.select();
    el.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    el.remove();
  }
}

/**
 * 把文本写进系统剪贴板。失败会抛错 —— **调用方必须处理**，
 * 因为"复制成功"的假象会让用户把空内容粘给别人（比报错难看得多）。
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (impl) return impl(text);
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: text });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (!legacyCopy(text)) throw new Error('这个环境不支持复制到剪贴板');
}

/**
 * 拼出"复制当前笔记"要写进剪贴板的内容。
 *
 * 默认在正文前面补上笔记标题当作一级标题：贴给别人时**没有标题的正文常常读不懂**
 * （尤其是一段没有上下文的想法）。标题已经作为一级标题写在正文开头时不重复添加 ——
 * 判据只看正文开头，不搜全文，免得用户正文里引用别处标题时把它误判掉。
 */
export function clipboardText(title: string, content: string, options?: { withTitle?: boolean }): string {
  const body = content.trim();
  if (options?.withTitle === false) return body;
  const name = title.trim();
  if (!name) return body;
  if (body.startsWith(`# ${name}`)) return body;
  return `# ${name}\n\n${body}`;
}
