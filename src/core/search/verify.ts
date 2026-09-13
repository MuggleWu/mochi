/**
 * "搜索命中的词真的在正文里吗" —— 展示前的最后一道核对。
 *
 * ## 为什么需要它
 *
 * 搜索只查倒排表，从不回头看正文。倒排表是增量维护的（摘旧 gram、挂新 gram），
 * 只要有一个环节漏摘，就会"搜一个词、搜出一篇根本没有这个词的笔记"，而且**看起来
 * 完全像真的**（有标题、有摘要、命中处还画着下划线）。这类错误比"搜不到"糟得多：
 * 用户会以为自己记错了。
 *
 * ## 为什么代价可以接受
 *
 * 这一段**本来就要读命中笔记的正文**去生成摘要（`snippetFor`），所以核对不额外读盘，
 * 只是把已经拿到的正文多看一眼。全库扫描是绝不会做的。
 *
 * ## 判定口径
 *
 * 与索引口径对齐：先做 `stripMarkdownNoise` 再比对，否则被 markdown 拆开的词
 * （`**个人**所得税` 里的"个人所得税"）会被误判成假命中 —— **宁可少报，不可误杀**。
 * 多个词之间是 and（与搜索一致），每个词用**子串**判定。
 */
import { stripMarkdownNoise } from './grams';

/** 查询串按空白切出的词（与搜索的词切分一致）。 */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}

/** 去掉全部空白：索引按空白切词，所以正文里的空白不该影响"在不在"的判断。 */
const squeeze = (s: string): string => s.replace(/\s+/g, '');

/**
 * 正文是否真的含有查询里的每一个词。
 *
 * 比对前**两边都压掉空白**。原因是 markdown 剥离会留下空格：`**个人**所得税` 会变成
 * ` 个人 所得税`，若不压空白，"个人所得税"就会被误判成没命中 —— 而它在索引里明明是
 * 命中的（索引同样按空白切词，两半的 gram 都在）。核对只该抓**凭空多出来的命中**，
 * 不该把正常的命中判死。压空白后仍匹配不上的，才是真对不上。
 */
export function textHasQuery(text: string, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true; // 空查询不判：那是"清空"而不是"搜索"
  const hay = squeeze(stripMarkdownNoise(text).toLowerCase());
  return words.every((w) => hay.includes(squeeze(w)));
}
