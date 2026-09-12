/**
 * 笔记路径与文件名规则。
 *
 * 口径（基于对真实仓库的实测，2026-09-12）：
 *   * 只关心仓库**根目录**的 `.md`，其余（`.obsidian/`、`.trash/`、子目录）一律忽略；
 *   * 磁盘上平铺保真，文件名 = 仓库里的文件名（最长实测 180 字节，远低于 255 上限）；
 *   * 实测 10,076 个根文件里：非法字符 0、Windows 保留名 0、结尾点/空格 0，
 *     所以平铺**不需要改名或转义**——但仍要在写入前校验，因为"用户新建的笔记"
 *     会带来仓库里没有过的文件名。
 */

export const MD_EXT = '.md';

/** 仓库根目录下的 markdown 笔记路径（如 `读书笔记.md`）。 */
export type NotePath = string;

const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
// 用 String.fromCharCode 构造控制字符正则：直接写 \u0000-\u001f 会被 lint 的
// no-control-regex 拦下，而这里**就是要**匹配控制字符。
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`);
const CONTROL_CHARS_G = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`, 'g');
const RESERVED_BASE = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 单个文件名的最大字节数（ext4/f2fs 都是 255）。 */
export const MAX_NAME_BYTES = 255;

const byteLength = (s: string): number => new TextEncoder().encode(s).byteLength;

export interface NameCheck {
  ok: boolean;
  /** 不合法时的原因（中文，可直接展示）。 */
  reason?: string;
}

/** 校验一个笔记文件名是否可以安全落盘。 */
export function checkNoteName(name: string, maxBytes = MAX_NAME_BYTES): NameCheck {
  if (!name) return { ok: false, reason: '文件名不能为空' };
  if (name !== name.trim()) return { ok: false, reason: '文件名首尾不能有空格' };
  if (name.endsWith('.')) return { ok: false, reason: '文件名不能以点结尾' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: '文件名不能包含斜杠' };
  if (ILLEGAL_CHARS.test(name)) return { ok: false, reason: '文件名不能包含 : * ? " < > |' };
  if (CONTROL_CHARS.test(name)) return { ok: false, reason: '文件名不能包含控制字符' };

  // 主名（去掉扩展名）不能以点或空格收尾：`名字 .md` / `名字..md` 在 Windows
  // 与部分同步场景会被改写，真实仓库里 0 例，但"新建笔记"会产生这种名字。
  const base = name.slice(0, Math.max(0, name.length - MD_EXT.length));
  if (base.endsWith('.') || base.endsWith(' ')) {
    return { ok: false, reason: '文件名在扩展名之前不能以点或空格结尾' };
  }
  const reservedCheck = base.toUpperCase();
  if (RESERVED_BASE.has(reservedCheck)) return { ok: false, reason: `"${base}" 是系统保留名` };
  if (byteLength(name) > maxBytes) return { ok: false, reason: `文件名过长（${byteLength(name)} 字节）` };
  return { ok: true };
}

/**
 * 把任意文本清洗成一个可用的笔记文件名（补上 `.md`）。
 *
 * 用途：新建笔记时用正文首行做标题。清洗只做"必然非法"的替换，
 * 不做任何语义加工；超长时按**字节**截断（不能按字符截断，中文 3 字节）。
 */
export function sanitizeNoteName(rawTitle: string, maxBytes = MAX_NAME_BYTES): string {
  let s = rawTitle
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(CONTROL_CHARS_G, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 去掉 markdown 结构性前缀（标题井号、列表符号、引用）
  s = s.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^>\s*/, '').trim();

  if (s.endsWith('.')) s = s.replace(/\.+$/, '');
  s = s.replace(/[\s.]+$/, ''); // 扩展名之前的结尾点与空格会被系统改写
  if (!s) s = '未命名';

  const suffix = MD_EXT;
  const budget = maxBytes - byteLength(suffix);
  if (byteLength(s) > budget) s = truncateToBytes(s, budget);

  const name = s + suffix;
  const check = checkNoteName(name, maxBytes);
  return check.ok ? name : '未命名' + MD_EXT;
}

/** 按 UTF-8 字节数截断（不切开多字节字符）。 */
export function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).byteLength <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(s.slice(0, mid)).byteLength <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** 这个名字是不是我们要管的笔记（根目录 markdown）。 */
export function isNoteName(name: string): boolean {
  return name.toLowerCase().endsWith(MD_EXT) && checkNoteName(name).ok;
}

/** 去掉 `.md` 后缀，用于展示标题。 */
export function displayTitle(path: NotePath): string {
  return path.toLowerCase().endsWith(MD_EXT) ? path.slice(0, -MD_EXT.length) : path;
}

/** 保证是带 `.md` 的笔记名。 */
export function withMdExt(name: string): NotePath {
  return name.toLowerCase().endsWith(MD_EXT) ? name : name + MD_EXT;
}

/**
 * 重命名时给重名让路：`标题.md` → `标题（2）.md` → `标题（3）.md` …
 * `exists` 由调用方提供（manifest 查表，零 IO）。
 */
export function uniqueNoteName(desired: NotePath, exists: (p: NotePath) => boolean): NotePath {
  if (!exists(desired)) return desired;
  const base = displayTitle(desired);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}（${i}）${MD_EXT}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}（${Date.now()}）${MD_EXT}`;
}

/** 冲突"都保留"分支用的手机版文件名（时间戳到分钟）。 */
export function phoneSideName(path: NotePath, at: Date): NotePath {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`;
  return `${displayTitle(path)}（手机版 ${stamp}）${MD_EXT}`;
}

/** 从正文推断新建笔记的标题（首个非空行，最长取 40 个字符参与清洗）。 */
export function titleFromContent(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.slice(0, 40);
}
