/**
 * 索引与磁盘的一致性自检。
 *
 * 为什么要单独有这么一个东西：搜索命中是"倒排表里记着某个 gram 出现在某篇"，
 * 而倒排表是**增量维护**的 —— 内容更新时靠"摘掉旧 gram、挂上新 gram"（`detach` + 挂载）。
 * 这套机制一旦在某个环节漏摘，表现是"搜一个词，搜出一篇根本没有这个词的笔记"。
 * 这种 bug 用肉眼读代码几乎看不出来：每个环节单独看都对。
 *
 * 所以这里换个角度验证 —— **拿磁盘上的真实正文重算一遍**，和索引里记的对照：
 *   - 索引说这篇有这些 gram，磁盘正文算出来必须有（多出来 = 漏摘，就是假命中）
 *   - 反过来少了不算错（没下载内容的笔记本来就不该有 gram）
 *
 * 只回答"哪篇、多了几个 gram"，不打印笔记内容。
 */
import { gramsOf } from './grams';
import type { SearchIndex } from './index';

export interface IndexDrift {
  /** 路径（相对仓库根）。 */
  path: string;
  /** 索引里记着、但按磁盘正文算不出来的 gram 个数（>0 就是假命中来源）。 */
  extraGrams: number;
  /** 磁盘上有、索引里却没有的 gram 个数（只说明索引落后，不影响正确性方向）。 */
  missingGrams: number;
}

/**
 * 逐篇核对索引与给定正文是否一致。
 *
 * `textOf` 返回 `null` 表示这篇本地没有正文（只有元数据），跳过不判。
 */
export function auditIndexAgainstText(
  index: SearchIndex,
  paths: readonly string[],
  textOf: (path: string) => string | null,
): IndexDrift[] {
  const out: IndexDrift[] = [];
  for (const path of paths) {
    const text = textOf(path);
    if (text === null) continue;
    const actual = new Set(gramsOf(text));
    const indexed = index.gramsOfDoc.get(path);
    if (!indexed) {
      // 磁盘上有正文、索引里一个字都没有：说明这篇还没被索引过（首启正在建），不算漂移
      if (actual.size > 0) out.push({ path, extraGrams: 0, missingGrams: actual.size });
      continue;
    }
    const recorded = new Set(indexed);
    let extra = 0;
    for (const g of recorded) if (!actual.has(g)) extra += 1;
    let missing = 0;
    for (const g of actual) if (!recorded.has(g)) missing += 1;
    if (extra > 0 || missing > 0) out.push({ path, extraGrams: extra, missingGrams: missing });
  }
  return out;
}
