import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memory-fs';
import { readTextsBatched } from './store';

describe('MemoryFileStore', () => {
  it('写读删与平铺列目录（只列直接子项）', async () => {
    const fs = new MemoryFileStore();
    await fs.writeText('notes/a.md', 'A');
    await fs.writeText('notes/b.md', 'BB');
    await fs.writeText('notes/sub/c.md', 'C');
    await fs.writeText('state/meta.json', '{}');

    const notes = await fs.list('notes');
    expect(notes.map((e) => e.name).sort()).toEqual(['a.md', 'b.md']);
    expect(notes.find((e) => e.name === 'b.md')?.size).toBe(2);

    expect(await fs.readText('notes/a.md')).toBe('A');
    await fs.remove('notes/a.md');
    expect(await fs.readText('notes/a.md')).toBeNull();
    await fs.remove('notes/a.md'); // 重复删不报错
  });

  it('中文内容与字节读回一致', async () => {
    const fs = new MemoryFileStore();
    const text = '# 标题\n\n公式 $$\\frac{a}{b}$$\n';
    await fs.writeText('notes/中文笔记.md', text);
    expect(await fs.readText('notes/中文笔记.md')).toBe(text);
    const bytes = await fs.readBytes('notes/中文笔记.md');
    expect(bytes && new TextDecoder().decode(bytes)).toBe(text);
  });
});

describe('readTextsBatched', () => {
  it('限制并发且不漏文件', async () => {
    const fs = new MemoryFileStore();
    const names = Array.from({ length: 50 }, (_, i) => `n${i}.md`);
    for (const n of names) await fs.writeText(`notes/${n}`, n);

    let inFlight = 0;
    let peak = 0;
    const original = fs.readText.bind(fs);
    fs.readText = async (name: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      const v = await original(name);
      inFlight -= 1;
      return v;
    };

    const out = await readTextsBatched(fs, 'notes', names, 8);
    expect(out.size).toBe(50);
    expect(peak).toBeLessThanOrEqual(8);
    expect(out.get('n7.md')).toBe('n7.md');
  });

  it('进度回调按完成数推进', async () => {
    const fs = new MemoryFileStore();
    await fs.writeText('notes/a.md', 'a');
    await fs.writeText('notes/b.md', 'b');
    const seen: number[] = [];
    await readTextsBatched(fs, 'notes', ['a.md', 'b.md'], 2, (done) => seen.push(done));
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('缺文件时跳过而不是抛错', async () => {
    const fs = new MemoryFileStore();
    await fs.writeText('notes/a.md', 'a');
    const out = await readTextsBatched(fs, 'notes', ['a.md', 'missing.md']);
    expect([...out.keys()]).toEqual(['a.md']);
  });
});
