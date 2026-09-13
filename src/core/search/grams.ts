/**
 * 把文本切成索引用的 gram 序列。
 *
 * 规则（设计文档 §4.3）：
 * 1. 先按空白切词，词内再按字符切 gram
 * 2. **汉字走"单字 + 相邻字对"**：查「知识库」= 知识∩识库，查「知」= 单字
 * 3. **拉丁/数字串走"单字 + 所有字对"**：字母表小，相邻对覆盖不了词中间的任意子串
 *    （"constitution" 查 "stitut" 会落空），而英文词短，O(n²) 可忽略
 * 4. 两者都发**单字**，否则单字查询（"税""法"）零命中 —— 这是中文里很常见的查法
 *
 * 为什么汉字不用"所有字对"：实测过，一万篇合成中文笔记的建索引从 3 秒涨到 36 秒，
 * 而收益仅是"能查不连续的任意两个字"，不值。
 *
 * 顺带做两件规范化：转小写、剥离 markdown 语法噪声。
 */

/**
 * 去掉 markdown 语法噪声。
 *
 * 为什么要在索引前做：`##`、`**`、表格竖线这些符号会混进 gram —— 中文里
 * 「## 知识库」会切出「##」「#知」这种一辈子搜不到的 gram，纯属浪费索引空间。
 */
export function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整体丢弃（里面的符号只会污染索引）
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ') // 公式内容不进索引
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) =>
      // 内链：`[[目标|别名]]` 两者都要能搜到
      label ? `${target} ${label}` : target,
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
    .replace(/^\s{0,3}>\s?/gm, ' ')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, ' ')
    .replace(/[*_~]{1,3}/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s{0,3}([-:]+)\s*$/gm, ' '); // 表格分隔行
}

/** 拉丁/数字串超过这个长度就只发相邻字对（所有字对是 O(n²)，长串会撑爆索引）。 */
const LATIN_ALL_PAIRS_LIMIT = 32;

/** 一个 gram 组的长度上限，兜住敌意输入。 */
const MAX_GRAMS_PER_WORD = 1024;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 把一个词切成"连续汉字段"与"非汉字段"（"KaTeX渲染" → ["KaTeX", "渲染"]）。 */
function runs(word: string): { text: string; cjk: boolean }[] {
  const out: { text: string; cjk: boolean }[] = [];
  for (const ch of word) {
    const isCjk = CJK.test(ch);
    const last = out[out.length - 1];
    if (last && last.cjk === isCjk) last.text += ch;
    else out.push({ text: ch, cjk: isCjk });
  }
  return out;
}

/** 相邻字对（查询侧用这套，保证"连续出现"）。 */
function adjacentPairs(chars: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.push((chars[i] ?? '') + (chars[i + 1] ?? ''));
  }
  return out;
}

/**
 * 单字 + 所有字对。**只给拉丁串用**：字母表只有 26 个，相邻对覆盖不了词中间的任意子串
 * （"constitution" 查 "stitut" 会落空），而英文词短，O(n²) 的代价可忽略。
 */
function allPairs(chars: readonly string[]): string[] {
  const out: string[] = [...chars];
  for (let i = 0; i < chars.length; i += 1) {
    for (let j = i + 1; j < chars.length; j += 1) {
      out.push((chars[i] ?? '') + (chars[j] ?? ''));
    }
  }
  return out;
}

export type GramMode = 'index' | 'query';

/**
 * 文本 → gram 序列（**可能重复**，调用方负责去重）。
 *
 * `mode` 是这套设计的关键：同一个词，索引时发宽、查询时发窄，
 * 两边共用同一份切分逻辑（切法不一致是搜索类 bug 的头号来源）。
 *
 * **汉字与拉丁串走两套策略**，这一点是实测逼出来的（一万篇合成语料）：
 * - 汉字：**单字 + 相邻字对**。汉字表大，相邻对已足以覆盖一切"连续出现"的查询；
 *   改成"所有字对"后建索引从 3 秒涨到 36 秒，收益只是能查"不连续的任意两个字"，不值。
 * - 拉丁串：**单字 + 所有字对**，理由见 `allPairs` 的注释。
 * - 两者都发单字，否则单字查询（"税""法"）零命中 —— 这是中文里很常见的查法。
 */
export function gramsOf(text: string, mode: GramMode = 'index'): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    for (const run of runs(word)) {
      const chars = [...run.text];
      if (chars.length === 1) {
        out.push(run.text);
        continue;
      }
      let grams: string[];
      if (mode === 'query') {
        grams = adjacentPairs(chars);
      } else if (run.cjk) {
        grams = [...chars, ...adjacentPairs(chars)];
      } else if (chars.length <= LATIN_ALL_PAIRS_LIMIT) {
        grams = allPairs(chars);
      } else {
        grams = adjacentPairs(chars);
      }
      for (const g of grams.slice(0, MAX_GRAMS_PER_WORD)) out.push(g);
    }
  }
  return out;
}

/**
 * 查询串 → 每个词的 gram 组。词之间是 and，词内是 and。
 */
export function queryTerms(query: string): string[][] {
  const terms: string[][] = [];
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    const grams = gramsOf(word, 'query');
    if (grams.length > 0) terms.push([...new Set(grams)]);
  }
  return terms;
}
