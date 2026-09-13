/**
 * 自检的测试。
 *
 * 要钉住的是"**对不上能被认出来**"：自检说没问题、实际有问题的后果很坏 ——
 * 用户会照着"一切正常"的判断去别处找原因，越找越远。
 *
 * 所以四种对不上的情形逐一验，而且**每种都要有一份"正常时不能误报"的对照**：
 * 误报同样有害（把正常的库说成坏的）。
 */
import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memory-fs';
import { hasProblem, selfCheck } from './self-check';
import { emptyMeta, FLAG, type Meta, type NoteEntry } from '../sync/manifest';

const entry = (path: string, over: Partial<NoteEntry> = {}): NoteEntry => ({
  path,
  localSha: 'l',
  remoteSha: 'r',
  syncedSha: 'r',
  size: 3,
  mtime: 0,
  fileMtime: 0,
  flags: 0,
  ...over,
});

const metaWith = (...entries: NoteEntry[]): Meta => ({
  ...emptyMeta(),
  notes: Object.fromEntries(entries.map((e) => [e.path, e])),
});

describe('自检：正常时不能误报', () => {
  it('清单和磁盘一一对应 → 没问题', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc' });
    const c = await selfCheck(store, metaWith(entry('甲.md')));

    expect(c.total).toBe(1);
    expect(c.onDisk).toBe(1);
    expect(c.mismatches).toEqual([]);
    expect(c.mismatchTotal).toBe(0);
    expect(hasProblem(c)).toBe(false);
  });

  it('空库也是正常的', async () => {
    const c = await selfCheck(new MemoryFileStore({}), emptyMeta());
    expect(c.total).toBe(0);
    expect(hasProblem(c)).toBe(false);
  });
});

describe('自检：四种对不上都要认出来', () => {
  it('清单说有、磁盘没有', async () => {
    const store = new MemoryFileStore({});
    const c = await selfCheck(store, metaWith(entry('甲.md')));
    expect(c.mismatchTotal).toBe(1);
    expect(c.mismatches[0]).toMatchObject({ path: '甲.md', kind: '清单说有、磁盘没有' });
    expect(hasProblem(c)).toBe(true);
  });

  it('磁盘有、清单没有', async () => {
    const store = new MemoryFileStore({ 'notes/多出来的.md': 'abc' });
    const c = await selfCheck(store, emptyMeta());
    expect(c.mismatchTotal).toBe(1);
    expect(c.mismatches[0]).toMatchObject({ path: '多出来的.md', kind: '磁盘有、清单没有', actual: 3 });
  });

  it('大小对不上（内容被改坏过）', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abcdefgh' }); // 8 字节
    const c = await selfCheck(store, metaWith(entry('甲.md', { size: 3 })));
    expect(c.mismatches[0]).toMatchObject({ path: '甲.md', kind: '大小对不上', expected: 3, actual: 8 });
  });

  it('同一篇只会被算一次（不会既算"没有"又算"大小不对"）', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abcdefgh' });
    const c = await selfCheck(store, metaWith(entry('甲.md', { size: 3 })));
    expect(c.mismatchTotal).toBe(1);
  });

  it('对不上的条数多了要截断，但总数要准', async () => {
    const store = new MemoryFileStore({});
    const many = Array.from({ length: 50 }, (_, i) => entry(`第${i}篇.md`));
    const c = await selfCheck(store, metaWith(...many));
    expect(c.mismatches).toHaveLength(20);
    expect(c.mismatchTotal).toBe(50);
  });
});

describe('自检：排序与同步相关的计数', () => {
  it('数出"修改时间还不知道"的篇数 —— 这些在列表里排不准', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc', 'notes/乙.md': 'abc' });
    const c = await selfCheck(
      store,
      metaWith(entry('甲.md', { fileMtime: 1700000000000 }), entry('乙.md', { fileMtime: 0 })),
    );
    expect(c.unknownMtime).toBe(1);
    // 时间未知本身不算"问题"：它的后果是排序不准，而不是数据坏了。
    // 历史核对是后台慢慢做的，把它标成问题会让诊断页长期挂着红色。
    expect(hasProblem(c)).toBe(false);
  });

  it('数出待推送的篇数', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc', 'notes/乙.md': 'abc' });
    const c = await selfCheck(
      store,
      metaWith(entry('甲.md', { flags: FLAG.DIRTY }), entry('乙.md')),
    );
    expect(c.dirty).toBe(1);
  });

  it('数出待决冲突的篇数，并算作问题', async () => {
    const store = new MemoryFileStore({ 'notes/甲.md': 'abc' });
    const meta = { ...metaWith(entry('甲.md')), conflicts: ['甲.md'] };
    const c = await selfCheck(store, meta);
    expect(c.conflicts).toBe(1);
    expect(hasProblem(c)).toBe(true);
  });

  it('内容还没下载的算作问题（点开会是空的）', async () => {
    const store = new MemoryFileStore({});
    const c = await selfCheck(store, metaWith(entry('甲.md', { localSha: '' })));
    expect(c.missingContent).toBe(1);
    expect(hasProblem(c)).toBe(true);
  });

  it('远端没这篇的 sha 时，磁盘上没有**不算**对不上', async () => {
    // 清单里留着这类条目是为了记住"远端删过"，它本来就不该在本地
    const store = new MemoryFileStore({});
    const c = await selfCheck(store, metaWith(entry('甲.md', { remoteSha: '' })));
    expect(c.mismatches).toEqual([]);
  });
});
