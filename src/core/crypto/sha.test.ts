/**
 * sha 计算的单测 —— 基准值是**本机真实 git** 算出来的，不是我自己编的：
 *
 *   printf 'hello' > a.md && git add a.md && git ls-files -s
 *   → b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
 */
import { describe, expect, it } from 'vitest';
import { blobShaOfBytes, blobShaOfText } from './sha';

describe('git blob sha', () => {
  it('空内容（git 的著名空 blob）', async () => {
    expect(await blobShaOfText('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('hello（对照本机 git ls-files -s）', async () => {
    expect(await blobShaOfText('hello')).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('hello + 换行（换行是内容的一部分，必须区分）', async () => {
    expect(await blobShaOfText('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('中文按 UTF-8 字节算（对照本机 git ls-files -s）', async () => {
    expect(await blobShaOfText('中文')).toBe('efbb13322ba66f682e179ebff5eeb1bd6ef83972');
  });

  it('字节与文本两条入口结果一致', async () => {
    const text = '# 标题\n\n正文 [[内部链接]] 与 $$x^2$$\n';
    expect(await blobShaOfBytes(new TextEncoder().encode(text))).toBe(await blobShaOfText(text));
  });

  it('长度参与计算（同内容不同长度前缀必然不同）', async () => {
    const a = await blobShaOfText('a');
    const b = await blobShaOfText('\0a');
    expect(a).not.toBe(b);
  });
});
