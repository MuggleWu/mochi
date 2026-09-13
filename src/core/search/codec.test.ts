import { describe, expect, it } from 'vitest';
import {
  decodeDeltaVarint,
  encodeDeltaVarint,
  encodeStringPool,
  poolStringAt,
} from './codec';

describe('差分 varint 编解码', () => {
  it('往返保持不变', () => {
    for (const list of [
      [],
      [0],
      [0, 1, 2, 3],
      [1, 100, 10_000, 1_000_000],
      [5, 5 + 127, 5 + 128, 5 + 129], // 卡在 varint 分组边界上
      [0, 128, 16_384, 2_097_152], // 每级 7 位进位
    ]) {
      expect(decodeDeltaVarint(encodeDeltaVarint(list))).toEqual(list);
    }
  });

  it('升序列表的编码结果比朴素编码小 —— 这是选它的唯一理由', () => {
    // 模拟一个真实倒排表：1 万篇里命中 200 篇，id 分散在 0..9999
    const ids = Array.from({ length: 200 }, (_, i) => i * 50);
    const naive = ids.length * 2; // 当每个 id 用 2 字节存
    const packed = encodeDeltaVarint(ids).length;
    expect(packed).toBeLessThan(naive);
    // 差值恒为 50 时，每个差值 1 字节
    expect(packed).toBe(ids.length);
  });

  it('大文档 id 也能正确编码（差值可能很大）', () => {
    const list = [0, 1, 100_000, 1_000_000];
    expect(decodeDeltaVarint(encodeDeltaVarint(list))).toEqual(list);
  });

  it('拒绝降序输入 —— 逆序说明上游排错了，早抛比默默写坏强', () => {
    expect(() => encodeDeltaVarint([5, 3])).toThrow(/升序/);
  });

  it('拒绝负数与小数', () => {
    expect(() => encodeDeltaVarint([-1])).toThrow(/非负整数/);
    expect(() => encodeDeltaVarint([1.5])).toThrow(/非负整数/);
  });

  it('损坏的数据解码时抛错，而不是给出错位的 id 列表', () => {
    // 截断：最后一个分组还带着"后续"标记
    expect(() => decodeDeltaVarint(Uint8Array.from([0x80]))).toThrow(/分组中途结束/);
  });
});

describe('字符串池', () => {
  it('往返保持不变（含空串与多字节）', () => {
    const strings = ['', '知识', 'abc', '税', '识库'];
    const { pool, offsets } = encodeStringPool(strings);
    const got = strings.map((_, i) => poolStringAt(pool, offsets, i));
    expect(got).toEqual(strings);
  });

  it('多字节字符按字节偏移而不是码位 —— 偏移算错会切出乱码', () => {
    const strings = ['知识库', 'abc'];
    const { pool, offsets } = encodeStringPool(strings);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(9); // 3 个汉字 = 9 字节
    expect(poolStringAt(pool, offsets, 1)).toBe('abc');
  });

  it('下标越界时抛错', () => {
    const { pool, offsets } = encodeStringPool(['a']);
    expect(() => poolStringAt(pool, offsets, 5)).toThrow(/越界/);
  });
});
