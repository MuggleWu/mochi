/**
 * 摘要与高亮的自测。
 *
 * 这块的失败模式很隐蔽：**高亮错位置**。搜出来一条结果、底下画着下划线，看起来就是
 * "这里命中了"，用户不会去核对下划线底下的字跟关键词有没有关系 —— 一旦画错，他会
 * 以为自己记错了，比"搜不到"糟得多。所以宁可不高亮，也不要圈一个不相干的字充数。
 */
import { describe, expect, it } from 'vitest';
import { snippetFor } from './search-view';

const FAKE_NUM = '020-0000-0000';

describe('摘要高亮', () => {
  it('整词在正文里 → 高亮的就是它本身', () => {
    const { snippet, hl } = snippetFor(`电话 ${FAKE_NUM} 打过了`, FAKE_NUM);
    expect(hl).toBeDefined();
    const [from, to] = hl!;
    expect(snippet.slice(from, to)).toBe(FAKE_NUM);
  });

  it('**整词不在正文里 → 绝不退回高亮第一个字**', () => {
    /*
     * 这条守的是真实踩过的坑：从前整词找不到时会退回高亮 needle 的第一个字符，
     * 于是搜一个十一位号码，正文里随便一个 `1` 就会让它画出一条下划线 ——
     * 一条看起来完全像真的假命中。
     */
    // 正文里**有** needle 的第一个字符（`0`），这正是旧的充数逻辑会咬住的东西
    const { snippet, hl } = snippetFor('0 年的事，跟号码无关', FAKE_NUM);
    expect(hl).toBeUndefined();
    expect(snippet).not.toBe('');
  });

  it('被 markdown 拆开的词：不误画（宁可不高亮）', () => {
    // 正文里确实有"个人所得税"，但被 ** 拆开了，压空白后也不连续
    const { hl } = snippetFor('关于**个人**所得税的规定', '个人所得税');
    expect(hl).toBeUndefined();
  });

  it('高亮区间不会越出摘要范围', () => {
    const long = '铺垫'.repeat(80) + FAKE_NUM + '尾声'.repeat(80);
    const { snippet, hl } = snippetFor(long, FAKE_NUM);
    expect(hl).toBeDefined();
    const [from, to] = hl!;
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeLessThanOrEqual(snippet.length);
    expect(snippet.slice(from, to)).toBe(FAKE_NUM);
  });

  it('空关键词不画高亮', () => {
    const { hl } = snippetFor('随便什么内容', '');
    expect(hl).toBeUndefined();
  });

  it('摘要围绕命中处截取，而不是永远只给开头', () => {
    const tail = '开头'.repeat(200) + FAKE_NUM;
    const { snippet, hl } = snippetFor(tail, FAKE_NUM);
    expect(hl).toBeDefined();
    expect(snippet).toContain(FAKE_NUM);
  });
});
