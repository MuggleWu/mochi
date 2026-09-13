/**
 * 差分 varint 编解码：倒排列表（升序文档 id）的磁盘格式。
 *
 * 为什么是这个格式：倒排表是**升序**的，存相邻差值就都是小整数（平均命中 15.8 篇时差值普遍在
 * 几百以内），再用 varint 一个字节装 7 位，实测 35.6 MB → 11.3 MB。增量更新要频繁插删，
 * 所以内存里保持普通数组、只在落盘时编码，不做内存态的差分表示（省内存但每次改动都要重编码）。
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * 普通 varint（**不做差分**）。
 *
 * 差分编码只在"序列本身升序"时才有意义（相邻差值才小）。**长度表不满足这个前提**：
 * 比如 1、1、5 这种有重复、有回落的序列，差分会出现 0 和负数，直接编不了。
 * 所以长度表用这个，倒排表与偏移表用差分版。
 */
export function encodeVarint(values: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`varint 只接受非负整数，收到 ${value}`);
    }
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  }
  return Uint8Array.from(bytes);
}

/** 解码普通 varint。 */
export function decodeVarintInto(bytes: Uint8Array): Uint32Array {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (((bytes[i] ?? 0) & 0x80) === 0) count += 1;
  }
  const out = new Uint32Array(count);
  let at = 0;
  let current = 0;
  let shift = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) throw new Error('varint 解码越界');
    current += (b & 0x7f) * shift;
    if ((b & 0x80) !== 0) {
      shift *= 128;
      if (shift > MAX_SAFE) throw new Error('varint 分组过多：数据已损坏');
      continue;
    }
    if (current > 0xffffffff) throw new Error('数值超出 32 位：数据已损坏');
    out[at] = current;
    at += 1;
    current = 0;
    shift = 1;
  }
  if (shift !== 1 || current !== 0) throw new Error('varint 数据在分组中途结束');
  return out;
}

/** 把一串非负整数按"相邻差值 + varint"编码。输入必须是升序且无重复。 */
export function encodeDeltaVarint(sorted: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let prev = 0;
  let first = true;
  for (const value of sorted) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`倒排列表只接受非负整数，收到 ${value}`);
    }
    const delta = first ? value : value - prev;
    if (delta < 0) {
      throw new Error('倒排列表必须升序（编码时才发现逆序说明上游排错了）');
    }
    first = false;
    prev = value;

    // varint：小端 7 位分组，最高位表示"还有后续"
    let rest = delta;
    while (rest >= 0x80) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  }
  return Uint8Array.from(bytes);
}

/** 解码回升序数组。越界或截断的数据一律当损坏抛出，由调用方决定重建。 */
export function decodeDeltaVarint(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 1;
  let current = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) throw new Error('varint 解码越界');
    current += (b & 0x7f) * shift;
    if (current > MAX_SAFE) throw new Error('varint 溢出：数据已损坏');
    if ((b & 0x80) !== 0) {
      shift *= 128;
      if (shift > MAX_SAFE) throw new Error('varint 分组过多：数据已损坏');
      continue;
    }
    value += current;
    out.push(value);
    current = 0;
    shift = 1;
  }
  if (shift !== 1 || current !== 0) throw new Error('varint 数据在分组中途结束');
  return out;
}

/**
 * 解码成 `Uint32Array`。
 *
 * 为什么要单独一个：倒排条目实测有 734 万条，用普通数组（每个元素 8 字节）光这一项就 58 MB，
 * 类型化数组是 29 MB。两次遍历换一半内存，值得。
 */
export function decodeDeltaVarintInto(bytes: Uint8Array): Uint32Array {
  // 第一遍只数个数，第二遍才写值
  let count = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (((bytes[i] ?? 0) & 0x80) === 0) count += 1;
  }
  const out = new Uint32Array(count);
  let at = 0;
  let value = 0;
  let shift = 1;
  let current = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) throw new Error('varint 解码越界');
    current += (b & 0x7f) * shift;
    if ((b & 0x80) !== 0) {
      shift *= 128;
      continue;
    }
    value += current;
    if (value > 0xffffffff) throw new Error('文档 id 超出 32 位：索引已损坏');
    out[at] = value;
    at += 1;
    current = 0;
    shift = 1;
  }
  if (shift !== 1 || current !== 0) throw new Error('varint 数据在分组中途结束');
  return out;
}

/**
 * 字符串键表：`grams.bin` 里 46 万个 gram 如果各自带长度前缀，光是表头就要好几 MB。
 * 所以统一放一个字符串池，倒排表只存偏移量。
 */
export function encodeStringPool(strings: readonly string[]): { pool: Uint8Array; offsets: number[] } {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let total = 0;
  for (const s of strings) {
    offsets.push(total);
    const part = new TextEncoder().encode(s);
    parts.push(part);
    total += part.length;
  }
  const pool = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    pool.set(part, at);
    at += part.length;
  }
  return { pool, offsets };
}

/** 从字符串池还原第 `index` 个串；偏移表按 `encodeStringPool` 的生成顺序给出。 */
export function poolStringAt(
  pool: Uint8Array,
  offsets: readonly number[],
  index: number,
): string {
  const start = offsets[index];
  if (start === undefined) throw new Error(`字符串池下标越界：${index}`);
  // 下一个串的起点即本串终点；末尾串取池尾
  const end = offsets[index + 1] ?? pool.length;
  const decoder = new TextDecoder();
  return decoder.decode(pool.subarray(start, end));
}
