import { describe, expect, it } from 'vitest';
import {
  CROWDED_HITS,
  DEFAULT_LIMIT,
  bindDocs,
  createIndex,
  deserializeIndex,
  needsIndex,
  removeNote,
  search,
  serializeIndex,
  updateNote,
  type SearchIndex,
} from './index';

function build(notes: Record<string, string>): SearchIndex {
  const index = createIndex();
  for (const [path, content] of Object.entries(notes)) updateNote(index, { path, content });
  return index;
}

const paths = (hits: { path: string }[]): string[] => hits.map((h) => h.path).sort();

describe('构建与查询', () => {
  it('中文子串与单字都能搜到', () => {
    const index = build({
      '税法.md': '个人所得税的计算方法',
      '会计.md': '财务与会计的基础',
    });
    expect(paths(search(index, '个人所得税'))).toEqual(['税法.md']);
    expect(paths(search(index, '所得'))).toEqual(['税法.md']);
    expect(paths(search(index, '税'))).toEqual(['税法.md']);
    expect(paths(search(index, '会计'))).toEqual(['会计.md']);
  });

  it('多词是 and 语义', () => {
    const index = build({
      'a.md': '个人所得税 计算 方法',
      'b.md': '个人所得税 申报 流程',
    });
    expect(paths(search(index, '个人所得税 计算'))).toEqual(['a.md']);
    expect(paths(search(index, '个人所得税'))).toEqual(['a.md', 'b.md']);
    expect(paths(search(index, '个人所得税 不存在词'))).toEqual([]);
  });

  it('markdown 语法不进索引（搜 `##` 不该命中任何东西）', () => {
    const index = build({ 'a.md': '## 标题\n\n正文内容' });
    expect(paths(search(index, '标题'))).toEqual(['a.md']);
    expect(search(index, '#')).toEqual([]);
    expect(search(index, '##')).toEqual([]);
  });

  it('代码块与公式内容不进索引', () => {
    const index = build({ 'a.md': '正文\n```\nconst foo = 1;\n```\n$$E=mc^2$$' });
    expect(paths(search(index, '正文'))).toEqual(['a.md']);
    expect(search(index, 'const')).toEqual([]);
    expect(search(index, 'foo')).toEqual([]);
  });

  it('空查询返回空 —— 别把整个库倒出来', () => {
    const index = build({ 'a.md': '内容' });
    expect(search(index, '')).toEqual([]);
    expect(search(index, '   ')).toEqual([]);
  });
});

describe('增量更新', () => {
  it('内容改了，旧词不能再命中（否则搜出来一篇没那个词的笔记）', () => {
    const index = build({ 'a.md': '苹果 香蕉' });
    expect(paths(search(index, '苹果'))).toEqual(['a.md']);

    updateNote(index, { path: 'a.md', content: '橘子 柚子' });
    expect(search(index, '苹果')).toEqual([]);
    expect(search(index, '香蕉')).toEqual([]);
    expect(paths(search(index, '橘子'))).toEqual(['a.md']);
  });

  it('同一路径重复索引不产生重复项', () => {
    const index = createIndex();
    updateNote(index, { path: 'a.md', content: '苹果' });
    updateNote(index, { path: 'a.md', content: '苹果' });
    updateNote(index, { path: 'a.md', content: '苹果' });
    const hits = search(index, '苹果');
    expect(hits).toHaveLength(1);
    expect(index.grams.get('苹果')?.length).toBe(1);
  });

  it('删除后搜不到，且 docId 不重排（其余笔记的 id 保持稳定）', () => {
    const index = build({ 'a.md': '苹果', 'b.md': '香蕉', 'c.md': '橘子' });
    const bIdBefore = index.docIdOf.get('b.md');
    removeNote(index, 'a.md');
    expect(search(index, '苹果')).toEqual([]);
    expect(paths(search(index, '香蕉'))).toEqual(['b.md']);
    expect(paths(search(index, '橘子'))).toEqual(['c.md']);
    expect(index.docIdOf.get('b.md')).toBe(bIdBefore);
  });

  it('删除不存在的笔记是空操作，不抛错', () => {
    const index = build({ 'a.md': '内容' });
    expect(() => removeNote(index, '不存在.md')).not.toThrow();
  });

  it('删除后重新加回来能正常命中', () => {
    const index = build({ 'a.md': '苹果', 'b.md': '香蕉' });
    removeNote(index, 'a.md');
    updateNote(index, { path: 'a.md', content: '苹果派' });
    expect(paths(search(index, '苹果'))).toEqual(['a.md']);
    expect(paths(search(index, '香蕉'))).toEqual(['b.md']);
  });

  it('needsIndex 按 sha 判断，避免重复索引同一份内容', () => {
    const index = createIndex();
    expect(needsIndex(index, 'a.md', 'sha1')).toBe(true);
    updateNote(index, { path: 'a.md', content: '内容', sha: 'sha1' });
    expect(needsIndex(index, 'a.md', 'sha1')).toBe(false);
    expect(needsIndex(index, 'a.md', 'sha2')).toBe(true);
  });

  it('从未建过索引的路径也算需要索引', () => {
    const index = createIndex();
    expect(needsIndex(index, '从来没有.md', 'sha1')).toBe(true);
  });
});

describe('排序与上限保护', () => {
  it('按 mtime 倒序返回（最近改的优先）', () => {
    const index = build({ 'old.md': '共同词', 'new.md': '共同词' });
    const mtime: Record<string, number> = { 'old.md': 100, 'new.md': 200 };
    const hits = search(index, '共同词', { mtimeOf: (p) => mtime[p] ?? 0 });
    expect(hits.map((h) => h.path)).toEqual(['new.md', 'old.md']);
  });

  it('不传 mtimeOf 时也能返回（顺序无所谓，但不能崩）', () => {
    const index = build({ 'a.md': '词' });
    expect(search(index, '词')).toHaveLength(1);
  });

  it('limit 生效', () => {
    const notes: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) notes[`n${i}.md`] = '共同词';
    const index = build(notes);
    expect(search(index, '共同词', { limit: 10 })).toHaveLength(10);
    expect(search(index, '共同词')).toHaveLength(Math.min(50, DEFAULT_LIMIT));
  });

  it('高频词（命中数远超阈值）仍按 mtime 取最新，且结果正确', () => {
    // 造一个高频 gram：让 CROWDED_HITS + 1000 篇都含"的"，逼出有界堆那条路径
    const total = CROWDED_HITS + 1000;
    const notes: Record<string, string> = {};
    for (let i = 0; i < total; i += 1) notes[`n${String(i).padStart(5, '0')}.md`] = `第${i}篇 的 内容`;
    const index = build(notes);
    const mtimeOf = (path: string): number => Number(path.slice(1, 6));
    const hits = search(index, '的', { mtimeOf, limit: 20 });
    expect(hits).toHaveLength(20);
    // 必须是 mtime 最大的那 20 篇（编号最大的），且顺序是倒序
    const newest = total - 1;
    expect(hits[0]?.path).toBe(`n${String(newest).padStart(5, '0')}.md`);
    expect(hits.map((h) => h.path)).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${String(newest - i).padStart(5, '0')}.md`),
    );
  });
});

describe('落盘与读回', () => {
  it('序列化再反序列化，查询结果一致', () => {
    const index = build({
      '税法.md': '个人所得税的计算',
      '会计.md': '财务与会计基础',
      '公式.md': '$$E=mc^2$$ 与正文',
    });
    const restored = deserializeIndex(serializeIndex(index));
    for (const q of ['个人所得税', '税', '会计', '正文', 'E=mc']) {
      expect(paths(search(restored, q))).toEqual(paths(search(index, q)));
    }
  });

  it('读回后路径仍然正确（路径不在倒排里，必须由索引文件自带）', () => {
    const index = build({ 'a.md': '苹果', 'b.md': '香蕉' });
    const restored = deserializeIndex(serializeIndex(index));
    expect(paths(search(restored, '苹果'))).toEqual(['a.md']);
    expect(paths(search(restored, '香蕉'))).toEqual(['b.md']);
  });

  it('删除留下的空槽在落盘读回后不被算作命中', () => {
    const index = build({ 'a.md': '苹果', 'b.md': '香蕉' });
    removeNote(index, 'a.md');
    const restored = deserializeIndex(serializeIndex(index));
    expect(search(restored, '苹果')).toEqual([]);
    expect(paths(search(restored, '香蕉'))).toEqual(['b.md']);
  });

  it('空索引也能往返', () => {
    const restored = deserializeIndex(serializeIndex(createIndex()));
    expect(restored.grams.size).toBe(0);
    expect(search(restored, '任意')).toEqual([]);
  });

  it('损坏/不匹配的文件抛错，由调用方决定重建（不静默给出错位结果）', () => {
    expect(() => deserializeIndex(new Uint8Array([1, 2, 3]))).toThrow(/过短/);
    const bad = serializeIndex(build({ 'a.md': '苹果' }));
    bad[0] = 0; // 破坏 magic
    expect(() => deserializeIndex(bad)).toThrow(/标识/);
  });

  it('倒排表读回后是类型化数组 —— 这是内存减半的来源', () => {
    const index = build({ 'a.md': '苹果' });
    const restored = deserializeIndex(serializeIndex(index));
    const list = restored.grams.get('苹果');
    expect(list).toBeInstanceOf(Uint32Array);
  });
});

describe('bindDocs', () => {
  it('能从路径列表重建映射', () => {
    const index = createIndex();
    bindDocs(index, ['b.md', 'a.md']);
    expect(index.docIdOf.get('a.md')).toBe(0);
    expect(index.docIdOf.get('b.md')).toBe(1);
  });
});
