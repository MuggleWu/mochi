import { describe, expect, it } from 'vitest';
import { resolveWikilink } from './wikilink';

const PATHS = ['复利公式.md', '年金.md', 'KaTeX 用法.md'];

describe('内链目标解析', () => {
  it('原样相等', () => {
    expect(resolveWikilink('复利公式.md', PATHS)).toEqual({ path: '复利公式.md', how: 'exact' });
  });

  it('不带 .md 也能命中（Obsidian 里最常用的写法）', () => {
    expect(resolveWikilink('复利公式', PATHS)).toEqual({ path: '复利公式.md', how: 'with-ext' });
  });

  it('带 .md 与不带 .md 指向同一篇', () => {
    const a = resolveWikilink('年金', PATHS);
    const b = resolveWikilink('年金.md', PATHS);
    expect(a?.path).toBe(b?.path);
  });

  it('忽略大小写', () => {
    expect(resolveWikilink('katex 用法', PATHS)?.path).toBe('KaTeX 用法.md');
    expect(resolveWikilink('KATEX 用法', PATHS)?.path).toBe('KaTeX 用法.md');
  });

  it('带目录的写法：先精确匹配完整路径，再退回最后一段', () => {
    // 本地平铺时路径不含 `/`，所以 `[[目录/笔记]]` 只能靠最后一段命中
    expect(resolveWikilink('随便什么/年金', PATHS)?.path).toBe('年金.md');
    // 但如果本地真有一篇路径含 `/`（不止一级目录的情况），精确匹配优先
    const nested = ['A/B.md', 'B.md'];
    expect(resolveWikilink('A/B', nested)?.path).toBe('A/B.md');
    expect(resolveWikilink('B', nested)?.path).toBe('B.md');
    // 最后一段落在另一个目录的同名笔记上，也比"找不到"强
    expect(resolveWikilink('Z/B', nested)?.path).toBe('B.md');
  });

  it('带锚点/块引用时忽略后半段', () => {
    expect(resolveWikilink('复利公式#推导', PATHS)?.path).toBe('复利公式.md');
    expect(resolveWikilink('复利公式^abc123', PATHS)?.path).toBe('复利公式.md');
    expect(resolveWikilink('复利公式.md#推导', PATHS)?.path).toBe('复利公式.md');
  });

  it('前后空白不影响', () => {
    expect(resolveWikilink('  年金  ', PATHS)?.path).toBe('年金.md');
  });

  it('找不到就返回 null —— 不猜，猜错会让用户点开别的笔记', () => {
    expect(resolveWikilink('不存在的一篇', PATHS)).toBeNull();
    expect(resolveWikilink('', PATHS)).toBeNull();
    expect(resolveWikilink('   ', PATHS)).toBeNull();
    expect(resolveWikilink('#只有锚点', PATHS)).toBeNull();
    expect(resolveWikilink('/', PATHS)).toBeNull();
  });

  it('空路径集合下不崩，返回 null', () => {
    expect(resolveWikilink('年金', [])).toBeNull();
  });

  it('不会把"复利"错配到"复利公式"（前缀不算命中）', () => {
    expect(resolveWikilink('复利', PATHS)).toBeNull();
  });
});
