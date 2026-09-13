import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../fs/memory-fs';
import { GRAMS_FILE } from '../fs/layout';
import { search, createIndex } from './index';
import { dropIndex, indexNotes, indexOne, loadIndex, saveIndex } from './store';
import type { IndexNote } from './store';

const note = (path: string, content: string, sha: string): IndexNote => ({
  path,
  content,
  sha,
  hasContent: true,
});

describe('索引落盘与读回', () => {
  it('存下去再读回来，搜索结果一致', async () => {
    const fs = new MemoryFileStore();
    const index = createIndex();
    indexNotes(index, [
      note('税法.md', '个人所得税的计算方法', 's1'),
      note('会计.md', '财务与会计的基础', 's2'),
    ]);
    await saveIndex(fs, index);

    const { index: restored, loaded } = await loadIndex(fs);
    expect(loaded).toBe(true);
    expect(search(restored, '个人所得税').map((h) => h.path)).toEqual(['税法.md']);
    expect(search(restored, '会计').map((h) => h.path)).toEqual(['会计.md']);
    expect(search(restored, '税').map((h) => h.path)).toEqual(['税法.md']);
  });

  it('读回后 docId 与路径的对应关系正确（错位会让搜索返回别人的笔记）', async () => {
    const fs = new MemoryFileStore();
    const index = createIndex();
    // 故意让"索引顺序"和"字典序"不一致
    indexNotes(index, [
      note('z.md', '只属于 z 的词 zebra', 's1'),
      note('a.md', '只属于 a 的词 apple', 's2'),
      note('m.md', '只属于 m 的词 mango', 's3'),
    ]);
    await saveIndex(fs, index);

    const { index: restored } = await loadIndex(fs);
    expect(search(restored, 'zebra').map((h) => h.path)).toEqual(['z.md']);
    expect(search(restored, 'apple').map((h) => h.path)).toEqual(['a.md']);
    expect(search(restored, 'mango').map((h) => h.path)).toEqual(['m.md']);
  });

  it('没有索引文件时 loaded=false，由调用方决定重建', async () => {
    const fs = new MemoryFileStore();
    const { index, loaded } = await loadIndex(fs);
    expect(loaded).toBe(false);
    expect(index.grams.size).toBe(0);
  });

  it('文件损坏时不抛异常，只报告"需要重建"', async () => {
    const fs = new MemoryFileStore();
    await fs.writeBytes(GRAMS_FILE, Uint8Array.from([1, 2, 3, 4, 5]));
    const { index, loaded } = await loadIndex(fs);
    expect(loaded).toBe(false);
    expect(index.grams.size).toBe(0);
  });

  it('删除索引文件后 loaded=false', async () => {
    const fs = new MemoryFileStore();
    const index = createIndex();
    indexNotes(index, [note('a.md', '内容', 's1')]);
    await saveIndex(fs, index);
    expect((await loadIndex(fs)).loaded).toBe(true);

    await dropIndex(fs);
    expect((await loadIndex(fs)).loaded).toBe(false);
  });
});

describe('增量索引', () => {
  it('同一份内容（sha 相同）不会重复索引', async () => {
    const index = createIndex();
    const notes = [note('a.md', '苹果', 's1'), note('b.md', '香蕉', 's2')];
    expect(indexNotes(index, notes)).toBe(2);
    expect(indexNotes(index, notes)).toBe(0); // 第二次全部跳过
  });

  it('sha 变了就重新索引，旧词不再命中', async () => {
    const index = createIndex();
    indexNotes(index, [note('a.md', '苹果', 's1')]);
    expect(search(index, '苹果')).toHaveLength(1);

    indexNotes(index, [note('a.md', '橘子', 's2')]);
    expect(search(index, '苹果')).toEqual([]);
    expect(search(index, '橘子').map((h) => h.path)).toEqual(['a.md']);
  });

  it('一批里既有新增又有更新，两边都要落对', async () => {
    const index = createIndex();
    indexNotes(index, [note('a.md', '苹果', 's1'), note('b.md', '香蕉', 's2')]);
    // 这一批：b 更新，c 新增
    indexNotes(index, [note('b.md', '柚子', 's3'), note('c.md', '西瓜', 's4')]);

    expect(search(index, '香蕉')).toEqual([]); // b 的旧内容已摘掉
    expect(search(index, '柚子').map((h) => h.path)).toEqual(['b.md']);
    expect(search(index, '苹果').map((h) => h.path)).toEqual(['a.md']); // a 没被动
    expect(search(index, '西瓜').map((h) => h.path)).toEqual(['c.md']);
  });

  it('没有内容的笔记不参与索引', () => {
    const index = createIndex();
    const added = indexNotes(index, [
      { path: 'x.md', content: '', sha: '', hasContent: false },
      note('y.md', '真内容', 's1'),
    ]);
    expect(added).toBe(1);
    expect(search(index, '真内容').map((h) => h.path)).toEqual(['y.md']);
  });

  it('indexOne 单篇增量：内容变了更新，hasContent=false 摘除', () => {
    const index = createIndex();
    indexOne(index, note('a.md', '苹果', 's1'));
    expect(search(index, '苹果')).toHaveLength(1);

    indexOne(index, note('a.md', '橘子', 's2'));
    expect(search(index, '苹果')).toEqual([]);
    expect(search(index, '橘子')).toHaveLength(1);

    indexOne(index, { path: 'a.md', content: '', sha: '', hasContent: false });
    expect(search(index, '橘子')).toEqual([]);
  });
});
