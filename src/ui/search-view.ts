/**
 * 抽屉里搜索结果的排序与摘要。
 *
 * 输入是两路命中（文件名、正文），输出是给虚拟列表直接渲染的行。
 * 放在 `ui/` 而不是 `core/`：这里做的是展示决策（剪多少字、怎么高亮），
 * 而"什么命中了"是 core 的职责。
 */

export type HitKind = 'name' | 'content';

export interface SearchRow {
  path: string;
  kind: HitKind;
  /** 正文命中时的摘要片段（已去掉 markdown 装饰，`hl` 区间是要高亮的词）。 */
  snippet?: string;
  /** 摘要里要高亮的区间 [start, end)。 */
  hl?: [number, number];
}

/** 摘要目标长度（字符）。一行放得下就行，太长反而看不清命中的位置。 */
const SNIPPET_LEN = 44;

/**
 * 把 markdown 装饰抹掉，**原样替换字符**（不增删字符）。
 *
 * 为什么坚持"不增删"：删掉 `**` 之后，摘要里所有偏移都会移位，
 * 高亮区间就会错位 —— 那是最容易悄悄出错的地方。宁可留一点空白。
 */
export function cleanForSnippet(text: string): string {
  const pad = (s: string, len: number): string => s + ' '.repeat(Math.max(0, len - s.length));
  return (
    text
      .replace(/^#{1,6}\s/gm, (m) => ' '.repeat(m.length))
      .replace(/^[-*+]\s/gm, '  ')
      .replace(/^>\s?/gm, ' ')
      .replace(/^\d+\.\s/gm, (m) => ' '.repeat(m.length))
      // `[[目标|别名]]` → 别名（用空格补齐到原长度，保证后面的偏移不变）
      .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, (m, _target: string, label: string) =>
        pad(label, m.length),
      )
      // `[[目标]]` → 目标
      .replace(/!?\[\[([^\]]+)\]\]/g, (m, inner: string) => pad(inner, m.length))
      // `[文字](地址)` → 文字（地址本来就不该出现在摘要里）
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, (m, label: string) => pad(label, m.length))
      .replace(/\*\*|__|\*|_|`/g, ' ')
  );
}

/**
 * 生成摘要：围绕第一处命中截一段，并给出高亮区间。
 *
 * 命中词优先在**摘要范围内**找；找不到就不高亮（正文里的词可能被 markdown 拆开了，
 * 比如 `**个人**所得税`）。宁可不高亮，也不要高亮错位置。
 */
export function snippetFor(raw: string, word: string): { snippet: string; hl?: [number, number] } {
  const text = cleanForSnippet(raw);
  const lower = text.toLowerCase();
  const needle = word.toLowerCase();

  let at = needle ? lower.indexOf(needle) : -1;
  if (at < 0 && needle) {
    // 整词找不到（可能跨了装饰符），退回找它的第一个字
    at = lower.indexOf(needle.slice(0, 1));
  }

  if (at < 0) {
    const head = text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
    return { snippet: head };
  }

  const start = Math.max(0, at - Math.floor(SNIPPET_LEN / 3));
  let body = text.slice(start, start + SNIPPET_LEN).replace(/\s+/g, ' ');
  // 压掉空白后偏移会变，重新在压缩后的片段里定位命中
  const compactAt = body.toLowerCase().indexOf(needle);
  if (compactAt >= 0) {
    return { snippet: body, hl: [compactAt, compactAt + needle.length] };
  }
  /*
   * 整词在**压过空白的片段**里仍然找不到（说明它被 markdown 拆开了，例如
   * `**个人**所得税`）。这时**宁可不高亮，也不要把某个字圈出来充数** ——
   * 早先的写法是退回高亮 needle 的第一个字符，于是搜十一位号码会因正文里随便
   * 一个 `1` 就画出一条下划线，看起来像命中、其实毫无关系。用户会以为自己记错了。
   */
  body = body.trim();
  return { snippet: body };
}

/**
 * 合并两路命中并排序。
 *
 * 顺序是刻意的：**文件名命中永远在前**。理由是"我要找那篇叫 X 的笔记"是最强意图，
 * 而正文命中可能有几百篇，把文件名命中埋进去等于让用户找不到自己要的那篇。
 */
export function mergeRows(
  nameHits: readonly string[],
  contentHits: readonly string[],
  snippetOf: (path: string) => { snippet: string; hl?: [number, number] },
  limit: number,
): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const path of nameHits) {
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, kind: 'name' });
  }
  for (const path of contentHits) {
    if (seen.has(path)) continue; // 文件名已命中就不重复列一遍
    seen.add(path);
    const { snippet, hl } = snippetOf(path);
    rows.push({ path, kind: 'content', snippet, ...(hl ? { hl } : {}) });
  }
  return rows.slice(0, limit);
}
