import { describe, expect, it } from 'vitest';
import { gramsOf, queryTerms, stripMarkdownNoise } from './grams';

/** 索引一篇文档、再按查询串取 gram，判断是否命中（模拟倒排求交）。 */
function hits(doc: string, query: string): boolean {
  const indexed = new Set(gramsOf(doc, 'index'));
  return queryTerms(query).every((term) => term.every((g) => indexed.has(g)));
}

describe('markdown 噪声剥离', () => {
  it('丢掉代码块与公式 —— 里面的符号只会污染索引', () => {
    const out = stripMarkdownNoise('正文\n```js\nconst x = 1;\n```\n$$x^2$$\n尾部');
    expect(out).toContain('正文');
    expect(out).toContain('尾部');
    expect(out).not.toContain('const');
    expect(out).not.toContain('x^2');
  });

  it('标题井号与表格竖线不进索引', () => {
    const out = stripMarkdownNoise('## 知识库\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |');
    expect(out).not.toContain('#');
    expect(out).not.toContain('|');
    expect(out).toContain('知识库');
  });

  it('内链的两半都可搜 —— [[目标|别名]] 两种写法都要能找到', () => {
    const out = stripMarkdownNoise('见 [[复利公式|复利]] 与 [[年金]]');
    expect(hits(out, '复利公式')).toBe(true);
    expect(hits(out, '复利')).toBe(true);
    expect(hits(out, '年金')).toBe(true);
  });

  it('外链保留可读文字、丢掉地址', () => {
    const out = stripMarkdownNoise('[官方文档](https://example.com/x)');
    expect(hits(out, '官方文档')).toBe(true);
    expect(out).not.toContain('example.com');
  });

  it('强调符号与列表符号不产生垃圾 gram', () => {
    const out = stripMarkdownNoise('- **重点**：内容');
    expect(out).not.toContain('*');
    expect(hits(out, '重点')).toBe(true);
  });
});

describe('查询命中（这是搜索正确性的核心）', () => {
  it('连续中文子串能命中', () => {
    const doc = '知识库管理与检索';
    expect(hits(doc, '知识库')).toBe(true);
    expect(hits(doc, '识库管理')).toBe(true);
    expect(hits(doc, '检索')).toBe(true);
  });

  it('**单个汉字也能命中** —— 设计文档的相邻 2-gram 方案在这里是零命中', () => {
    const doc = '知识库管理与检索';
    for (const ch of ['知', '识', '库', '管', '理', '检', '索']) {
      expect(hits(doc, ch)).toBe(true);
    }
  });

  it('词中部"不连续"的两个汉字搜不到 —— 这是有意放弃的能力', () => {
    // "知识库管理" 的索引 gram 是 单字 + 相邻对（知识/识库/库管/管理）。
    // "识管" 不是任何相邻对，所以查不到。要做"任意两个字"就得发所有字对，
    // 实测让一万篇的建索引从 3 秒涨到 36 秒 —— 为这种罕见的查法不值。
    expect(hits('知识库管理', '识管')).toBe(false);
    // 但只要两个字在文中相邻过就能命中（这才是绝大多数查询的形态）
    expect(hits('知识库管理', '识库')).toBe(true);
  });

  it('英文整词命中，且大小写无关', () => {
    const doc = 'The Constitution of Japan';
    expect(hits(doc, 'constitution')).toBe(true);
    expect(hits(doc, 'CONSTITUTION')).toBe(true);
  });

  it('英文长词的子串也能命中（未超过 128 码位时发所有字对）', () => {
    expect(hits('constitution', 'stitut')).toBe(true);
    expect(hits('constitution', 'tutio')).toBe(true);
  });

  it('多词是 and 语义：全都要出现', () => {
    const doc = '个人所得税的计算方法';
    expect(hits(doc, '个人所得税 计算')).toBe(true);
    expect(hits(doc, '个人所得税 增值税')).toBe(false);
  });

  it('不存在的词不命中（避免"什么都搜得到"的假阳性泛滥）', () => {
    const doc = '个人所得税的计算方法';
    expect(hits(doc, '增值税')).toBe(false);
    expect(hits(doc, '企业所得税')).toBe(false);
  });

  it('中文与英文混排：两种都能搜', () => {
    const doc = '使用 KaTeX 渲染公式的笔记';
    expect(hits(doc, '渲染')).toBe(true);
    expect(hits(doc, 'katex')).toBe(true);
    expect(hits(doc, 'KaTeX 渲染')).toBe(true);
  });
});

describe('gram 生成', () => {
  it('单字与单字母词直接成为 gram', () => {
    expect(gramsOf('税', 'index')).toEqual(['税']);
    expect(gramsOf('a', 'query')).toEqual(['a']);
  });

  it('查询侧只发相邻字对 —— 这是"连续出现"语义的来源', () => {
    expect(gramsOf('知识库', 'query')).toEqual(['知识', '识库']);
  });

  it('索引侧发单字 + 相邻字对，因此是查询侧的超集', () => {
    const indexed = new Set(gramsOf('知识库', 'index'));
    for (const g of gramsOf('知识库', 'query')) expect(indexed.has(g)).toBe(true);
    expect(indexed.has('识')).toBe(true); // 单字：没有它单字查询就零命中
    // 汉字不发"所有字对"（那是 36 秒 vs 3 秒的代价），所以跨字对不在索引里
  });

  it('拉丁串发所有字对，词中间的任意子串才搜得到', () => {
    const index = new Set(gramsOf('constitution', 'index'));
    // 查询侧只发相邻字对，所以能被搜到的子串 = 它的相邻字对全都躺在索引里
    const searchable = (q: string): boolean =>
      gramsOf(q, 'query').every((g) => index.has(g));
    expect(searchable('stitut')).toBe(true); // 非相邻字对，只有"所有字对"才覆盖得到
    expect(searchable('constit')).toBe(true);
    expect(searchable('ution')).toBe(true);
    expect(searchable('xyz')).toBe(false); // 库里没有的字对
  });

  it('超长词退回相邻字对，但仍受 gram 数上限保护', () => {
    const long = 'a'.repeat(500);
    const grams = gramsOf(long, 'index');
    expect(grams.length).toBeLessThanOrEqual(1024);
    expect(grams.length).toBeGreaterThan(0);
  });

  it('空白与空串不产生 gram', () => {
    expect(gramsOf('   ', 'index')).toEqual([]);
    expect(gramsOf('', 'query')).toEqual([]);
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('   ')).toEqual([]);
  });

  it('queryTerms 对每个词去重 —— 重复 gram 会让求交白算一遍', () => {
    const terms = queryTerms('知识库');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toEqual(['知识', '识库']);
  });
});
