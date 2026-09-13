/**
 * "词真的在正文里吗"的判定测试。
 *
 * 这块最怕的是**误杀**：把本来正常的命中判成假的，用户就会"明明有却搜不到"。
 * 所以边界用例比正常用例更重要（markdown 把词拆开、大小写、多词 and 语义）。
 */
import { describe, expect, it } from 'vitest';
import { queryWords, textHasQuery } from './verify';

describe('词是否真的在正文里', () => {
  it('普通命中', () => {
    expect(textHasQuery('今天打了电话 020-0000-0000 没人接', '020-0000-0000')).toBe(true);
  });

  it('普通未命中', () => {
    expect(textHasQuery('今天打了一个电话没人接', '020-0000-0000')).toBe(false);
  });

  it('**大小写不敏感**（索引也是小写的）', () => {
    expect(textHasQuery('用 GitHub 同步', 'github')).toBe(true);
    expect(textHasQuery('用 github 同步', 'GitHub')).toBe(true);
  });

  it('**markdown 把词拆开也算命中**（否则就是误杀）', () => {
    expect(textHasQuery('**个人**所得税怎么算', '个人所得税')).toBe(true);
    expect(textHasQuery('见 [[知识库|库]] 那篇', '知识库')).toBe(true);
  });

  it('多个词是 and（与搜索一致）', () => {
    expect(textHasQuery('苹果 香蕉 橘子', '苹果 橘子')).toBe(true);
    expect(textHasQuery('苹果 香蕉', '苹果 橘子')).toBe(false);
  });

  it('代码块里的词不算命中（索引在建时就丢掉了代码块）', () => {
    expect(textHasQuery('```\nsecret123\n```', 'secret123')).toBe(false);
  });

  it('空查询不判（那是"清空"，不是"搜索"）', () => {
    expect(textHasQuery('随便什么', '')).toBe(true);
    expect(textHasQuery('随便什么', '   ')).toBe(true);
  });

  it('词切分与搜索一致', () => {
    expect(queryWords('  苹果   橘子 ')).toEqual(['苹果', '橘子']);
    expect(queryWords('')).toEqual([]);
  });

  it('全角与半角不做归一（索引也没做，两边口径必须一致）', () => {
    // 记录当前口径：不做全半角折叠。将来若要支持，两边必须一起改。
    expect(textHasQuery('１２３', '123')).toBe(false);
  });
});
