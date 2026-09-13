/**
 * 在**渲染好的 DOM** 上标出查找命中。
 *
 * 为什么不把标记做进 markdown 渲染管线：渲染结果是 HTML 字符串，要通过
 * `dangerouslySetInnerHTML` 塞进去。把标记编码进字符串就得处理"命中的文字正好
 * 落在 HTML 标签里"这种情况（比如搜 `div` —— 用户想找正文里的 div，不能把标签改了）。
 * 在**文本节点**上走一遍就没有这个问题：文本节点里的内容天然只是文本。
 *
 * 另一条硬要求：**绝不改动渲染结果本身**。每次打标记前先把上一次的标记拆掉、
 * 原样还原，这样反复查找不会让 DOM 越滚越大，也不会污染后续渲染。
 */

/** 标记用的属性名。 */
const MARK_ATTR = 'data-find';

/**
 * 清掉上一次的标记，把内容还原成"没查过"的样子。
 *
 * 用 `normalize()` 把被拆散的相邻文本节点合回去 —— 不合并的话，同一段文字会被
 * 切成好几块，下次查找跨块就找不到（真的会漏命中）。
 */
export function clearFindMarks(root: ParentNode): void {
  const marks = root.querySelectorAll(`mark[${MARK_ATTR}]`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
  }
  if (marks.length > 0) (root as unknown as Node).normalize?.();
}

/**
 * 需要跳过标记的区域。
 *
 * 代码块（`pre`/`code`）里的文字背景是深色的，`<mark>` 的黄色底会把字吃成
 * 看不清 —— 与其标了看不见，不如不标。公式（katex 会渲染成一堆 span）同理，
 * 拆开它的内部结构可能直接把公式弄坏，代价远大于收益。
 */
function skipZone(node: Node): boolean {
  let el = node.parentElement;
  while (el) {
    const tag = el.tagName;
    if (tag === 'PRE' || tag === 'CODE' || el.classList.contains('katex')) return true;
    el = el.parentElement;
  }
  return false;
}

export interface MarkResult {
  /** 实际标出来的数量。可能少于匹配数 —— 代码块/公式里的匹配会被跳过。 */
  marked: number;
}

/**
 * 标出全部命中，并把 `current` 那处标记为当前项。
 *
 * `query` 为空时只做清理。
 */
export function markMatches(root: ParentNode, query: string, current: number): MarkResult {
  clearFindMarks(root);
  if (!query) return { marked: 0 };

  const doc = (root as unknown as Node).ownerDocument ?? document;
  const needle = query.toLowerCase();

  // 先收集文本节点再改：边遍历边插节点会让 TreeWalker 的游标错乱、漏掉后面的节点
  const walker = doc.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node.nodeValue ?? '';
      if (!text.trim()) return NodeFilter.FILTER_REJECT;
      if (skipZone(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

  let marked = 0;
  for (const textNode of targets) {
    const text = textNode.nodeValue ?? '';
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;

    const frag = doc.createDocumentFragment();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      if (at > from) frag.appendChild(doc.createTextNode(text.slice(from, at)));
      const mark = doc.createElement('mark');
      mark.setAttribute(MARK_ATTR, '');
      // 标完之后 `current` 才确定是第几个 —— 这里先全标，之后再挑当前项
      mark.setAttribute('data-find-i', String(marked));
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      marked += 1;
      from = at + needle.length;
    }
    if (from < text.length) frag.appendChild(doc.createTextNode(text.slice(from)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  if (current >= 0 && current < marked) {
    root.querySelector(`mark[${MARK_ATTR}][data-find-i="${current}"]`)?.setAttribute('data-find-current', '');
  }
  return { marked };
}
