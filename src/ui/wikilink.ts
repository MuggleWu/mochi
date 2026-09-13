/**
 * 内链目标的解析：`[[目标]]` → 本地实际存在的笔记路径。
 *
 * Obsidian 的内链写法很宽松（可以带 `.md`、可以不带、可以带路径、可以只是标题），
 * 而 miki 这一侧是**平铺**存放的（`notes/` 下就是文件名），所以这里要做的其实是
 * "把各种写法归一化到某个真实文件名"。
 *
 * 找不到时返回 null，由调用方决定怎么提示 —— **不要猜**：猜错会让用户点开另一篇笔记，
 * 那比"找不到"更让人困惑。
 */

const MD_EXT = '.md';

export interface ResolveResult {
  /** 命中的真实路径（文件名）。 */
  path: string;
  /** 命中的方式，用于诊断与测试。 */
  how: 'exact' | 'with-ext' | 'base' | 'ci';
}

/**
 * 在已知的笔记路径集合里解析内链目标。
 *
 * 依次尝试（越靠前越精确）：
 * 1. 原样相等
 * 2. 补 `.md` 相等
 * 3. 去掉 `.md` 后相等（`[[笔记.md]]` 与 `[[笔记]]` 都能命中 `笔记.md`）
 * 4. 取路径最后一段再试一遍（内链写了 `[[目录/笔记]]` 而本地平铺存放）
 * 5. 忽略大小写相等（英文文件名大小写不一致是常见写法差异）
 *
 * 都失败就返回 null。
 */
export function resolveWikilink(target: string, paths: readonly string[]): ResolveResult | null {
  const raw = target.trim();
  if (raw === '') return null;

  // 内链可能带锚点与块引用：`[[笔记#小节]]`、`[[笔记^块]]`
  const withoutAnchor = raw.split('#')[0]?.split('^')[0]?.trim() ?? '';
  if (withoutAnchor === '') return null;

  // 先按完整名字试（万一本地的路径真含子目录），不行再只取最后一段。
  // 顺序很重要：直接取最后一段会让 `[[A/B]]` 命中 A 目录下的同名笔记，
  // 也可能命中另一个目录里的同名笔记 —— 能精确匹配就不该走模糊那一步。
  const candidates = withoutAnchor.includes('/')
    ? [withoutAnchor, withoutAnchor.split('/').pop() ?? withoutAnchor]
    : [withoutAnchor];

  for (const candidate of candidates) {
    const hit = tryCandidate(candidate, paths);
    if (hit) return hit;
  }
  return null;
}

function tryCandidate(name: string, paths: readonly string[]): ResolveResult | null {
  if (name === '') return null;
  const set = new Set(paths);
  if (set.has(name)) return { path: name, how: 'exact' };

  const withExt = name.endsWith(MD_EXT) ? name : `${name}${MD_EXT}`;
  if (set.has(withExt)) return { path: withExt, how: 'with-ext' };

  const withoutExt = name.endsWith(MD_EXT) ? name.slice(0, -MD_EXT.length) : name;
  const guessed = `${withoutExt}${MD_EXT}`;
  if (set.has(guessed)) return { path: guessed, how: 'base' };

  const lower = guessed.toLowerCase();
  for (const path of paths) {
    if (path.toLowerCase() === lower) return { path, how: 'ci' };
  }
  return null;
}
