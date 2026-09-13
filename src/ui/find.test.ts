import { describe, expect, it } from 'vitest';
import { findMatches, matchLabel, replaceAllLiteral, replaceOne, stepIndex } from './find';

describe('找匹配', () => {
  it('中文与英文都能找', () => {
    // 「所」在第 3 个字符（下标 2），两处分别在 2 和 6
    expect(findMatches('个人所得税与所得税', '所得税')).toEqual([
      { start: 2, end: 5 },
      { start: 6, end: 9 },
    ]);
    expect(findMatches('hello world', 'world')).toEqual([{ start: 6, end: 11 }]);
  });

  it('默认不区分大小写，可要求区分', () => {
    expect(findMatches('Hello hello', 'hello')).toHaveLength(2);
    expect(findMatches('Hello hello', 'hello', { caseSensitive: true })).toHaveLength(1);
  });

  it('空查询返回空数组（不是"匹配所有位置"）', () => {
    // 否则界面会显示"共 12345 处"，纯噪声
    expect(findMatches('随便什么内容', '')).toEqual([]);
  });

  it('匹配不重叠：aaa 里找 aa 只有一处', () => {
    // 重叠匹配在替换时无法同时生效，两处定义不一致会变成"找到 2 处只替换了 1 处"
    expect(findMatches('aaa', 'aa')).toEqual([{ start: 0, end: 2 }]);
  });

  it('按字符位置工作，不受换行影响', () => {
    const text = '第一行\n第二行';
    expect(findMatches(text, '第二行')).toEqual([{ start: 4, end: 7 }]);
  });
});

describe('循环跳转', () => {
  it('下一个：走到末尾回到开头', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
  });

  it('上一个：在第一处往回走到末尾', () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -1)).toBe(0);
  });

  it('没有匹配时恒为 0（不出现 -1 这种下标）', () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(5, 0, -1)).toBe(0);
  });
});

describe('替换', () => {
  it('全部替换', () => {
    expect(replaceAllLiteral('苹果和苹果', '苹果', '橘子')).toBe('橘子和橘子');
  });

  it('替换串里的 $ 按字面量处理（这是会改坏笔记的坑，不是显示问题）', () => {
    // String.replaceAll 会把 $& 解释成"整个匹配"，用户想输入字面量 $& 时会被悄悄改掉
    expect(replaceAllLiteral('价格是 X 元', 'X', '$&100')).toBe('价格是 $&100 元');
    expect(replaceAllLiteral('abc', 'b', '$1')).toBe('a$1c');
    expect(replaceAllLiteral('abc', 'b', '$`')).toBe('a$`c');
    expect(replaceAllLiteral('abc', 'b', '$$')).toBe('a$$c');
  });

  it('替换串里含反斜杠也原样保留', () => {
    expect(replaceAllLiteral('路径 X', 'X', 'C:\\新\\目录')).toBe('路径 C:\\新\\目录');
  });

  it('查询串里的正则元字符按字面量找', () => {
    // 用户搜 "a.b" 是想找真的 "a.b"，不是"a 任意字符 b"。
    // axby 不算命中（`.` 若被当通配符就会误命中），xa.by 才算。
    expect(findMatches('xa.by 和 axby', 'a.b')).toEqual([{ start: 1, end: 4 }]);
    // 「a.b」三个字符换成一个「-」，后面的 y 还在，所以是 x-y
    expect(replaceAllLiteral('xa.by 和 axby', 'a.b', '-')).toBe('x-y 和 axby');
  });

  it('空查询不改变内容', () => {
    expect(replaceAllLiteral('原文', '', '替换')).toBe('原文');
  });

  it('不区分大小写时替换保留为统一的替换串', () => {
    expect(replaceAllLiteral('Cat cat', 'cat', 'dog')).toBe('dog dog');
  });

  it('替换当前一处', () => {
    const m = findMatches('苹果和苹果', '苹果');
    expect(replaceOne('苹果和苹果', m[1]!, '橘子')).toBe('苹果和橘子');
  });

  it('替换成空串 = 删除', () => {
    expect(replaceAllLiteral('a-b-c', '-', '')).toBe('abc');
  });
});

describe('计数文案', () => {
  it('没查询就不显示', () => {
    expect(matchLabel(0, 0, '')).toBe('');
  });

  it('没匹配时明说', () => {
    expect(matchLabel(0, 0, '找不到的词')).toBe('没有匹配');
  });

  it('有匹配时显示"第几处 / 共几处"（给用户看的从 1 开始）', () => {
    expect(matchLabel(5, 0, 'x')).toBe('1 / 5');
    expect(matchLabel(5, 4, 'x')).toBe('5 / 5');
  });
});
