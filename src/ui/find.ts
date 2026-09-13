/**
 * 查找的纯逻辑：找匹配、循环跳转、替换。
 *
 * 抽成纯函数是为了**能测**：查找里有好几个"看着对、实际会错"的地方，
 * 尤其是"替换时 `$` 要不要当特殊符号"——那是会**静默改错内容**的 bug，
 * 不是显示问题，必须在单测里钉住。
 */

/** 一处匹配：`start` 含、`end` 不含。 */
export interface Match {
  start: number;
  end: number;
}

export interface FindOptions {
  /** 区分大小写。默认否。 */
  caseSensitive?: boolean;
}

/**
 * 找出全部匹配。
 *
 * 两条规则：
 * - **空查询返回空数组**，不是"匹配所有位置"。空串会让每个位置都算一处匹配，
 *   界面上显示"共 12345 处"，纯属噪声。
 * - 匹配**不重叠**（`aaa` 里找 `aa` 得到 1 处，不是 2 处）。理由：替换时重叠
 *   匹配无法同时生效，两处定义不一致会让"找到了 2 处但只替换了 1 处"变成 bug。
 */
export function findMatches(content: string, query: string, options: FindOptions = {}): Match[] {
  if (!query) return [];
  const haystack = options.caseSensitive ? content : content.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push({ start: at, end: at + needle.length });
    from = at + needle.length; // 不重叠
  }
  return out;
}

/**
 * 当前该跳到第几处。
 *
 * `delta` 为 +1 / -1 时**循环**：在最后一处按"下一个"回到第一处。
 * 不循环的话用户得手动反向找，而查找栏上是"下一个"这种语义，循环才符合预期。
 */
export function stepIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

/**
 * 把 `replace` 当**纯文本**替换掉全部匹配。
 *
 * 为什么不能直接用 `String.replaceAll(query, replace)`：那个 API 会把替换串里的
 * `$&`、`$1`、`` $` `` 当**特殊记号**解释。用户想替换成 `$&` 这种字面量时，
 * 结果会被悄悄改成别的内容 —— 这是改坏笔记，不是显示问题。
 *
 * 两条分支都用**替换函数**而不是替换串：函数的返回值永远是字面量，不需要再
 * 自己搞一套 `$` 转义。少一套转义就少一处会写错的地方。
 */
export function replaceAllLiteral(content: string, query: string, replace: string, options: FindOptions = {}): string {
  if (!query) return content; // 空查询会让 replaceAll 抛错，也可能把内容改成怪样子
  const pattern = new RegExp(escapeRegExp(query), options.caseSensitive ? 'g' : 'gi');
  return content.replace(pattern, () => replace);
}

/**
 * 替换**当前这一处**（`match` 由调用方按当前索引给出）。
 *
 * 用替换函数而不是替换串，理由同上：用户输入什么就原样放进去。
 */
export function replaceOne(content: string, match: Match, replace: string): string {
  return content.slice(0, match.start) + replace + content.slice(match.end);
}

/** 正则元字符转义（只给上面的不区分大小写分支用）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 查找栏上的计数文案。没有查询时给空串（不显示）。 */
export function matchLabel(total: number, index: number, query: string): string {
  if (!query) return '';
  if (total === 0) return '没有匹配';
  return `${index + 1} / ${total}`;
}
