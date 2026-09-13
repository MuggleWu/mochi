/**
 * 全文倒排索引（设计文档 §4.3）。
 *
 * 内存：`grams: Map<gram, 升序 docId 列表>` + `docs: path[]`（下标即 docId）
 * 磁盘：`state/grams.bin` —— 头 + 字符串池 + 偏移/长度表 + 差分 varint 的倒排数据
 *
 * 几个刻意的选择：
 *
 * 1. **docId 只增不减**。删除笔记时把倒排里的 id 摘掉，但**不重排 id** ——
 *    重排意味着全量重建倒排，而"删一篇笔记"不该是几秒级的操作。空出来的 id 就空着。
 * 2. **倒排表两种表示**：从磁盘读进来的是 `Uint32Array`（省内存），一旦要改就转成普通数组。
 *    读取路径完全一样，所以求交代码不需要关心这个区别。
 * 3. **落盘是完整重写**。增量更新只改内存；落盘时整体编码（11.3 MB 量级），
 *    频率由调用方控制（每批内容下载完存一次，而不是每篇存一次）。
 */

import { decodeDeltaVarintInto, decodeVarintInto, encodeDeltaVarint, encodeStringPool, encodeVarint } from './codec';
import { gramsOf, stripMarkdownNoise } from './grams';

/** 内存里的倒排表。 */
export type Postings = Uint32Array | number[];

export interface SearchIndex {
  /** gram → 升序 docId 列表 */
  grams: Map<string, Postings>;
  /** docId → path（下标即 id；已删除的笔记留空串占位，保证 id 不重排） */
  docs: string[];
  /** path → docId */
  docIdOf: Map<string, number>;
  /**
   * path → 建索引时的内容 sha。
   * 有它才能判断"这篇的内容我索引过没有"，否则每次同步都要把已下载的内容重索引一遍。
   */
  indexedSha: Map<string, string>;
  /**
   * path → 这篇贡献的 gram 列表（**去重后**）。
   *
   * 存它只有一个理由，但是决定性的：不存的话"摘掉一篇笔记"要遍历整个 gram 表
   * （实测 1 万个 gram × 1 万篇 = 1 亿次判断，35 秒里有 30 秒耗在这）。
   * 存下来后摘除成本只与"这篇有多少 gram"有关（约 900 个）。
   */
  gramsOfDoc: Map<string, string[]>;
  /**
   * 倒排表是否可能未排序。
   *
   * 批量建索引时为了避开"逐次二分插入引发的数组搬移"（O(n) 每次，实测占一半时间），
   * 先无脑追加、最后统一排序。查询与摘除都要求升序，所以用这个标志做惰性排序。
   */
  dirty: boolean;
}

export interface IndexedNote {
  path: string;
  content: string;
  /** 内容 sha；有就记下来，避免重复索引同一份内容。 */
  sha?: string;
}

/** 命中数超过它就不做全量排序，直接按 mtime 取最新 —— 保证"永不卡顿"。 */
export const CROWDED_HITS = 2000;

export const DEFAULT_LIMIT = 200;

export const INDEX_VERSION = 1;
const MAGIC = 0x4d4f4348; // "MOCH"

/**
 * 清掉空倒排表。
 *
 * 只在落盘前调用：空列表在内存里是"删除留下的坑"，占地方（几十万个 key）但读的时候
 * 不产生命中。清掉之后 `grams.size` 与倒排表数量仍然一致，序列化对齐不受影响。
 */
export function pruneEmpty(index: SearchIndex): number {
  let removed = 0;
  for (const [gram, list] of index.grams) {
    if (list.length === 0) {
      index.grams.delete(gram);
      removed += 1;
    }
  }
  return removed;
}

export function createIndex(): SearchIndex {
  return {
    grams: new Map(),
    docs: [],
    docIdOf: new Map(),
    indexedSha: new Map(),
    gramsOfDoc: new Map(),
    dirty: false,
  };
}

/** 升序数组里是否存在 id。 */
function listHas(list: Postings, id: number): boolean {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(list[mid]) < id) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length && Number(list[lo]) === id;
}

/**
 * 摘掉若干 docId 后写回。
 *
 * 注意**不删除空列表**：`grams.size` 与倒排表数量必须始终一致，序列化靠这个对齐。
 * 空列表在读的时候天然不产生命中，落盘前由 `pruneEmpty` 清掉。
 */
function writeBack(index: SearchIndex, gram: string, next: number[]): void {
  index.grams.set(gram, next);
}

/** 拿到可改的倒排表（类型化数组不可原地改大小，先转普通数组）。 */
function mutable(list: Postings | undefined): number[] {
  if (!list) return [];
  return list instanceof Uint32Array ? Array.from(list) : list;
}

/** 插入（保持升序、去重）。绝大多数情况是新 id 最大，先试尾巴。 */
function insertSorted(list: number[], id: number): void {
  const len = list.length;
  if (len > 0 && Number(list[len - 1]) >= id) {
    if (Number(list[len - 1]) === id) return;
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(list[mid]) < id) lo = mid + 1;
      else hi = mid;
    }
    if (Number(list[lo]) === id) return;
    list.splice(lo, 0, id);
    return;
  }
  list.push(id);
}

function removeSorted(list: number[], id: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(list[mid]) < id) lo = mid + 1;
    else hi = mid;
  }
  if (lo < list.length && Number(list[lo]) === id) list.splice(lo, 1);
}

/** 一条笔记的正文 → 去重后的 gram 列表。 */
function uniqueGrams(content: string): string[] {
  return [...new Set(gramsOf(stripMarkdownNoise(content), 'index'))];
}

/** 分配（或复用）docId。 */
function ensureDocId(index: SearchIndex, path: string): number {
  const existed = index.docIdOf.get(path);
  if (existed !== undefined) return existed;
  const id = index.docs.length;
  index.docs.push(path);
  index.docIdOf.set(path, id);
  return id;
}

/**
 * 增量：把一篇笔记挂进倒排。
 *
 * 同一路径重复调用是安全的：先把旧的挂载摘掉再挂新的（内容改了必须这样做，
 * 否则旧内容里的词会永远留在索引里，搜出来一篇根本没有那个词的笔记）。
 */
export function updateNote(index: SearchIndex, note: IndexedNote): void {
  if (note.path === '') throw new Error('笔记路径不能为空');
  // 摘除与插入都依赖升序（二分），批量追加留下的乱序先在这里收口
  ensureSorted(index);

  const id = ensureDocId(index, note.path);
  detach(index, id, note.path); // 首次索引时为空操作

  const grams = uniqueGrams(note.content);
  for (const gram of grams) {
    const next = mutable(index.grams.get(gram));
    insertSorted(next, id);
    index.grams.set(gram, next);
    // 刻意不在这里 delete 空列表：删了会让"gram 数 == 倒排表数"这条不变量失效，
    // 而序列化正是靠它对齐两张表。
    // 空列表统一在落盘前清掉，那时才安全。
  }
  index.gramsOfDoc.set(note.path, grams);

  if (index.docs[id] !== note.path) index.docs[id] = note.path;
  if (note.sha !== undefined) index.indexedSha.set(note.path, note.sha);
}

/**
 * 批量建索引时的快路径：**只追加，不排序，不做去重**。
 *
 * 为什么值得单独一条路径：`insertSorted` 在 id 落在数组中间时要搬移整段数组（O(n)），
 * 建 1 万篇的索引会触发上百万次搬移 —— 实测 35 秒里约一半耗在这。
 * 这里改成无脑 push，最后 `finishBuild()` 统一排序一次。
 *
 * 前提：同一篇笔记只调用一次（批量构建的场景天然满足）。
 */
export function appendNote(index: SearchIndex, note: IndexedNote): void {
  if (note.path === '') throw new Error('笔记路径不能为空');
  const id = ensureDocId(index, note.path);
  const grams = uniqueGrams(note.content);
  for (const gram of grams) {
    const list = index.grams.get(gram);
    if (list instanceof Uint32Array) throw new Error('批量建索引不接受类型化数组');
    if (list) list.push(id);
    else index.grams.set(gram, [id]);
  }
  index.gramsOfDoc.set(note.path, grams);
  if (index.docs[id] !== note.path) index.docs[id] = note.path;
  if (note.sha !== undefined) index.indexedSha.set(note.path, note.sha);
  index.dirty = true;
}

/** 批量追加结束后调用：排序 + 去重，把倒排表恢复成升序。 */
export function finishBuild(index: SearchIndex): void {
  ensureSorted(index);
}

/** 惰性排序：批量追加过就排一次，之后查询/摘除都按"已升序"处理。 */
export function ensureSorted(index: SearchIndex): void {
  if (!index.dirty) return;
  for (const [gram, list] of index.grams) {
    if (list instanceof Uint32Array) {
      if (isAscending(list)) continue;
      const sorted = Array.from(list).sort((a, b) => a - b);
      index.grams.set(gram, dedupe(sorted));
      continue;
    }
    if (isAscending(list)) {
      // 已升序也可能有重复（批量追加没去重），仍然要过渡一遍
      if (list.length < 2) continue;
      const seen = dedupe(list);
      if (seen.length !== list.length) index.grams.set(gram, seen);
      continue;
    }
    index.grams.set(gram, dedupe([...list].sort((a, b) => a - b)));
  }
  index.dirty = false;
}

function isAscending(list: Postings): boolean {
  for (let i = 1; i < list.length; i += 1) {
    if (Number(list[i]) < Number(list[i - 1])) return false;
  }
  return true;
}

function dedupe(sorted: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/** 从一篇笔记贡献的那些 gram 上把它摘掉（不遍历整张 gram 表）。 */
function detach(index: SearchIndex, id: number, path: string): void {
  const grams = index.gramsOfDoc.get(path);
  if (!grams) return;
  for (const gram of grams) {
    const list = index.grams.get(gram);
    if (!list || !listHas(list, id)) continue;
    const next = mutable(list);
    removeSorted(next, id);
    writeBack(index, gram, next);
  }
  index.gramsOfDoc.delete(path);
}

/**
 * 增量：摘掉一篇笔记的全部倒排条目。
 * **docId 保留不重排**，`docs[id]` 置空串占位。
 */
export function removeNote(index: SearchIndex, path: string): void {
  const id = index.docIdOf.get(path);
  if (id === undefined) return;
  ensureSorted(index);
  detach(index, id, path);
  index.docs[id] = '';
  index.docIdOf.delete(path);
  index.indexedSha.delete(path);
}

/** 这篇的内容是否需要（重新）索引。 */
export function needsIndex(index: SearchIndex, path: string, sha: string): boolean {
  return index.indexedSha.get(path) !== sha;
}

export interface SearchOptions {
  limit?: number;
  /** path → mtime，用于按最近修改排序。 */
  mtimeOf?: (path: string) => number;
}

export interface SearchHit {
  path: string;
  /** 命中的词个数（多词查询时用来把"全都命中"的排前面）。 */
  terms: number;
}

/**
 * 查询：只支持 and 语义（词之间、词内 gram 之间都取交集）。
 *
 * 做法是"从最短的倒排表开始，逐个用后面的过滤它"——比两两求交再合并省内存，
 * 且短表先过滤能最快把候选集压小。
 */
export function search(index: SearchIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  ensureSorted(index);
  const terms = queryTermsFor(query);
  if (terms.length === 0) return [];

  const groups: Postings[] = [];
  for (const grams of terms) {
    let acc: Postings | null = null;
    for (const gram of grams) {
      const list = index.grams.get(gram);
      if (!list || list.length === 0) {
        // 词内任一 gram 都查不到 → 这个词不可能命中，整个查询失败（and 语义）
        return [];
      }
      acc = acc === null ? list : intersect(acc, list);
      if (acc.length === 0) return [];
    }
    if (acc) groups.push(acc);
  }

  // 词间求交
  let candidates = groups[0] ?? [];
  for (let i = 1; i < groups.length; i += 1) {
    const other = groups[i];
    if (other) candidates = intersect(candidates, other);
    if (candidates.length === 0) return [];
  }

  return rank(index, candidates, terms.length, options);
}

function queryTermsFor(query: string): string[][] {
  const terms: string[][] = [];
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    const grams = [...new Set(gramsOf(word, 'query'))];
    if (grams.length > 0) terms.push(grams);
  }
  return terms;
}

function intersect(a: Postings, b: Postings): number[] {
  // 从短的一端迭代，另一头二分
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const out: number[] = [];
  for (let i = 0; i < small.length; i += 1) {
    const id = Number(small[i]);
    let lo = 0;
    let hi = big.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(big[mid]) < id) lo = mid + 1;
      else hi = mid;
    }
    if (lo < big.length && Number(big[lo]) === id) out.push(id);
  }
  return out;
}

/**
 * 排序取值。
 *
 * **保护**：高频词（"的""一"）可能命中近万篇，全量排序会把主线程卡住几百毫秒。
 * 命中数超过 `CROWDED_HITS` 时就**不排序**，直接按 mtime 取最新的若干篇 ——
 * 这样"最近修改的优先"仍然成立，且耗时与命中数无关。
 */
function rank(
  index: SearchIndex,
  candidates: Postings,
  termCount: number,
  options: SearchOptions,
): SearchHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const mtimeOf = options.mtimeOf ?? ((): number => 0);

  // 候选集通常只有几十到几百篇，直接排序最省事也最快
  if (candidates.length <= CROWDED_HITS) {
    const rows: { path: string; mtime: number }[] = [];
    for (const id of candidates) {
      const path = index.docs[id];
      if (!path) continue; // 已删除的占位
      rows.push({ path, mtime: mtimeOf(path) });
    }
    rows.sort((x, y) => y.mtime - x.mtime);
    return rows.slice(0, limit).map((r) => ({ path: r.path, terms: termCount }));
  }

  // 高频词（"的"能命中近万篇）：**不排序**，用容量 limit 的最小堆取最新若干篇。
  // 复杂度 O(n log limit) 而不是 O(n log n)，且与命中数几乎无关 —— 界面永不卡顿。
  const heap = new BoundedHeap(limit);
  for (const id of candidates) {
    const path = index.docs[id];
    if (!path) continue;
    heap.push({ path, mtime: mtimeOf(path) });
  }
  return heap.sortedDesc().map((r) => ({ path: r.path, terms: termCount }));
}

/** 只保留最大的 `capacity` 个元素的堆（按 mtime）。 */
class BoundedHeap {
  private readonly items: { path: string; mtime: number }[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: { path: string; mtime: number }): void {
    if (this.capacity <= 0) return;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      this.up(this.items.length - 1);
      return;
    }
    const min = this.items[0];
    if (min && item.mtime > min.mtime) {
      this.items[0] = item;
      this.down(0);
    }
  }

  sortedDesc(): { path: string; mtime: number }[] {
    return [...this.items].sort((x, y) => y.mtime - x.mtime);
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = this.items[i];
      const b = this.items[parent];
      if (!a || !b || b.mtime <= a.mtime) break;
      this.items[i] = b;
      this.items[parent] = a;
      i = parent;
    }
  }

  private down(i: number): void {
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      const cur = this.items[smallest];
      const l = this.items[left];
      const r = this.items[right];
      if (l && cur && l.mtime < cur.mtime) smallest = left;
      const s = this.items[smallest];
      if (r && s && r.mtime < s.mtime) smallest = right;
      if (smallest === i) return;
      const a = this.items[i];
      const b = this.items[smallest];
      if (!a || !b) return;
      this.items[i] = b;
      this.items[smallest] = a;
      i = smallest;
    }
  }
}

/* ---------------------------------- 落盘 ---------------------------------- */

export function serializeIndex(index: SearchIndex): Uint8Array {
  ensureSorted(index); // 倒排必须先升序：差分编码与求交都依赖它
  pruneEmpty(index);
  const grams = [...index.grams.keys()].sort();
  const postings: Uint8Array[] = [];
  for (const gram of grams) {
    const list = index.grams.get(gram);
    if (!list) throw new Error('索引在序列化期间被改动');
    postings.push(encodeDeltaVarint(Array.from(list, Number)));
  }

  const lens = postings.map((p) => p.length);
  // 不变量：gram 表与倒排表按同一顺序对齐（读回时靠下标一一对应）。
  // 长度表用**普通 varint**（不差分）：长度有重复有回落，差分编码从根上不适用。
  if (lens.length !== grams.length) throw new Error('倒排表数量与 gram 数量不符');
  const { pool, offsets } = encodeStringPool(grams);

  const offsetBytes = encodeDeltaVarint(offsets);
  const lenBytes = encodeVarint(lens);
  const postBytes = concat(postings);

  /*
   * 路径段：把 `docs` 各槽的路径也存进去。
   *
   * 为什么不靠外部传进来重建：docId 是按当初索引的顺序分配的，**顺序一变整体错位**，
   * 搜出来的就是别人的笔记。这种 bug 表现为"结果看起来挺像那么回事但都是错的"，最难查。
   * 让文件自带路径表，读回就是自洽的。
   *
   * 空槽（已删除）用一个无效偏移 0xffffffff 占位，读回时还原成空串。
   */
  const slots: string[] = [];
  for (const path of index.docs) slots.push(path === '' ? '\u0000' : path);
  const slotsPool = encodeStringPool(slots);
  const slotOffsets = encodeDeltaVarint(slotsPool.offsets);
  const slotFlagBytes = flagsOf(slots);

  const header = new Uint8Array(36);
  const view = new DataView(header.buffer);
  view.setUint32(0, MAGIC);
  view.setUint16(4, INDEX_VERSION);
  view.setUint16(6, 0); // 对齐留白，以后加字段不用改布局
  view.setUint32(8, grams.length);
  view.setUint32(12, pool.length);
  view.setUint32(16, offsetBytes.length);
  view.setUint32(20, lenBytes.length);
  view.setUint32(24, slots.length);
  view.setUint32(28, slotsPool.pool.length);
  view.setUint32(32, slotOffsets.length);

  return concat([header, pool, offsetBytes, lenBytes, postBytes, slotsPool.pool, slotOffsets, slotFlagBytes]);
}

export function deserializeIndex(bytes: Uint8Array): SearchIndex {
  if (bytes.length < 36) throw new Error('索引文件过短');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC) throw new Error('索引文件标识不符');
  const version = view.getUint16(4);
  if (version !== INDEX_VERSION) throw new Error(`索引版本不符：${version}`);

  const gramCount = view.getUint32(8);
  const poolLen = view.getUint32(12);
  const offsetLen = view.getUint32(16);
  const lenLen = view.getUint32(20);
  const slotCount = view.getUint32(24);
  const slotsPoolLen = view.getUint32(28);
  const slotOffsetsLen = view.getUint32(32);

  let at = 36;
  const pool = bytes.subarray(at, at + poolLen);
  at += poolLen;
  const offsetBytes = bytes.subarray(at, at + offsetLen);
  at += offsetLen;
  const lenBytes = bytes.subarray(at, at + lenLen);
  at += lenLen;

  const offsets = decodeDeltaVarintInto(offsetBytes);
  const lens = decodeVarintInto(lenBytes);
  const decoder = new TextDecoder();

  const index = createIndex();
  let postAt = at;
  for (let i = 0; i < gramCount; i += 1) {
    const start = offsets[i] ?? 0;
    const end = offsets[i + 1] ?? poolLen;
    const gram = decoder.decode(pool.subarray(start, end));
    const len = lens[i] ?? 0;
    const list = decodeDeltaVarintInto(bytes.subarray(postAt, postAt + len));
    postAt += len;
    if (list.length > 0) index.grams.set(gram, list);
  }

  // 路径段：gram 倒排之后紧跟槽位池、槽位偏移、槽位标记
  const slotsPool = bytes.subarray(postAt, postAt + slotsPoolLen);
  at = postAt + slotsPoolLen;
  const slotOffsets = decodeDeltaVarintInto(bytes.subarray(at, at + slotOffsetsLen));
  at += slotOffsetsLen;
  const slotFlags = bytes.subarray(at, at + slotCount);

  index.docs = new Array<string>(slotCount).fill('');
  index.docIdOf = new Map();
  for (let id = 0; id < slotCount; id += 1) {
    if (slotFlags[id] === 0) continue; // 空槽（已删除）
    const start = slotOffsets[id] ?? 0;
    const end = slotOffsets[id + 1] ?? slotsPoolLen;
    const path = decoder.decode(slotsPool.subarray(start, end));
    if (path === '') continue;
    index.docs[id] = path;
    index.docIdOf.set(path, id);
  }
  return index;
}

/** 槽位是否有效（1 = 有路径，0 = 空槽）。用字节而不是 varint：空槽太常见。 */
function flagsOf(slots: readonly string[]): Uint8Array {
  const out = new Uint8Array(slots.length);
  slots.forEach((path, i) => {
    out[i] = path === '\u0000' ? 0 : 1;
  });
  return out;
}

/**
 * 用 manifest 把 path → docId 与 docs 填回来。
 *
 * 为什么要这一步：磁盘上只存了倒排的 docId，路径不在里面（存了会白白多几 MB）。
 * 恢复时必须**按当初分配 id 的同一顺序**（path 字典序）重建映射，否则搜出来的
 * 路径会整体错位 —— 那是最难查的一类 bug。
 */
export function bindDocs(index: SearchIndex, paths: readonly string[]): void {
  const sorted = [...paths].sort();
  index.docs = sorted.slice();
  index.docIdOf = new Map();
  sorted.forEach((path, id) => index.docIdOf.set(path, id));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
