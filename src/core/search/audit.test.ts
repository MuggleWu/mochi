/**
 * 索引一致性自检的单测。
 *
 * 重点是**能抓出假命中**：索引说某篇有某个 gram，而它的正文里其实没有。
 * 这种状态不会自己出现，一定来自"增量更新时旧 gram 没摘干净"，所以用注入的方式构造。
 */
import { describe, expect, it } from 'vitest';
import { auditIndexAgainstText } from './audit';
import { gramsOf } from './grams';
import { createIndex, updateNote, type SearchIndex } from './index';

const textOf = (notes: Record<string, string>) => (path: string): string | null =>
  path in notes ? notes[path]! : null;

describe('索引与磁盘正文的一致性自检', () => {
  it('刚建好的索引没有漂移', () => {
    const index = createIndex();
    const notes = { 'a.md': '橘子 柚子', 'b.md': '苹果 香蕉' };
    for (const [path, content] of Object.entries(notes)) updateNote(index, { path, content });
    expect(auditIndexAgainstText(index, Object.keys(notes), textOf(notes))).toEqual([]);
  });

  it('**抓得住假命中**：索引里记着一个正文没有的词', () => {
    const index = createIndex();
    const notes = { 'a.md': '橘子 柚子' };
    updateNote(index, { path: 'a.md', content: notes['a.md']! });
    // 手工把"苹果"的 gram 也挂到 a.md 上 —— 模拟"旧 gram 没摘干净"
    const ghost = gramsOf('苹果');
    for (const g of ghost) {
      const list = index.grams.get(g) ?? [];
      if (!list.includes(0)) {
        index.grams.set(g, [...list, 0].sort((x, y) => x - y));
        index.gramsOfDoc.set('a.md', [...(index.gramsOfDoc.get('a.md') ?? []), g]);
      }
    }
    const drift = auditIndexAgainstText(index, ['a.md'], textOf(notes));
    expect(drift).toHaveLength(1);
    expect(drift[0]?.path).toBe('a.md');
    expect(drift[0]?.extraGrams).toBeGreaterThan(0);
  });

  it('内容改小之后（增量更新走对路）仍然没有漂移', () => {
    const index = createIndex();
    updateNote(index, { path: 'a.md', content: '橘子 柚子 苹果' });
    // 真的把"苹果"去掉了，走正规的更新路径
    updateNote(index, { path: 'a.md', content: '橘子 柚子' });
    const notes = { 'a.md': '橘子 柚子' };
    expect(auditIndexAgainstText(index, ['a.md'], textOf(notes))).toEqual([]);
  });

  it('本地没有正文的笔记跳过不判（只有元数据，本来就没 gram）', () => {
    const index: SearchIndex = createIndex();
    const drift = auditIndexAgainstText(index, ['只有元数据.md'], () => null);
    expect(drift).toEqual([]);
  });

  it('还没索引过的笔记算"落后"，不算假命中', () => {
    const index = createIndex();
    const notes = { 'a.md': '橘子' };
    const drift = auditIndexAgainstText(index, ['a.md'], textOf(notes));
    expect(drift).toHaveLength(1);
    expect(drift[0]?.extraGrams).toBe(0);
    expect(drift[0]?.missingGrams).toBeGreaterThan(0);
  });
});
