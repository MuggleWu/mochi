/**
 * markdown 渲染管线：markdown-it + KaTeX。
 *
 * 复用 miki 移动端已验证的方案（那个项目里的 `src/shared/markdown.ts`），
 * 因为它里面有一段**必须先做**的处理：公式要被抽成占位符、渲染完再回填 KaTeX。
 *
 * 为什么不能直接把 `$...$` 丢给 markdown-it：markdown 会把公式里的 `_` `*` `<` 当成
 * 强调/标签标记吃掉，`$a_b$` 渲染出来就成了斜体 `a` 加一个 `b`。
 * 占位符换成不会被 markdown 解释的形态，渲染完再塞回 KaTeX 的输出。
 */
import MarkdownIt from 'markdown-it';
import katex from 'katex';

export interface MarkdownRenderer {
  render(src: string): string;
}

/** 块级公式 `$$...$$`（可跨行）。 */
const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g;
/** 行内公式 `$...$`（不跨行；跨行的话一个孤立的 `$` 会把后面整段吃掉）。 */
const INLINE_MATH = /\$([^$\n]+?)\$/g;

/**
 * Obsidian 内链 `[[目标]]` / `[[目标|别名]]`。
 *
 * 形态按设计文档 §386 定：`[[目标]]`、`[[目标|别名]]`、`[[#标题]]`、`[[目标#标题]]`。
 * 目标里的 `#标题` 与 `|别名` 都是**显示无关**的部分，指向的文件名才是关键。
 *
 * M2 只把它们渲染成"看得见是链接"的样子，**点击跳转留到 M4 之后**（用户 2026-09-13 拍的板）。
 * 先做成 `<span data-wikilink>` 而不是 `<a>`：点了不会有任何事，也就不会误导。
 */
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

/** 解析一段 wikilink 的正文，拆出目标文件与显示文字。 */
export function parseWikilink(raw: string): { target: string; label: string } {
  const pipe = raw.indexOf('|');
  const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : '';
  const linkPart = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
  // [[#标题]] 这种只指向本文档内的标题，没有目标文件
  const hash = linkPart.indexOf('#');
  const target = (hash >= 0 ? linkPart.slice(0, hash) : linkPart).trim();
  const heading = hash >= 0 ? linkPart.slice(hash + 1).trim() : '';
  return {
    target,
    label: alias || target || heading || raw,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createMarkdownRenderer(): MarkdownRenderer {
  const md = MarkdownIt({
    // 笔记库是用户自己的内容，但**不解析内联 HTML**：Obsidian 笔记里出现 `<` 的场景
    // 大多是数学与文本比较，当成标签解析只会吃内容（设计文档 §411「可信内容：不 sanitize」
    // 的前提也是"不让原始 HTML 进 DOM"）。
    html: false,
    linkify: true,
    // 用户 2026-09-13 明确："软换行就行"—— 单个换行就断行，与 Obsidian 阅读态一致
    breaks: true,
  });

  // 外链一律新开并断开 opener。移动端由 WebView 打开（外链确认与系统浏览器跳转是 M2 之后的事）
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    // noUncheckedIndexedAccess 下 tokens[idx] 是可空的，先收窄再改属性
    const token = tokens[idx];
    if (token) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return {
    render(src: string): string {
      const math: { expr: string; display: boolean }[] = [];
      const stashMath = (expr: string, display: boolean): string => {
        math.push({ expr, display });
        // 占位符用「纯字母数字 + 数字序号」，且前后加空格形态：
        // 不能让 markdown 有机会把它当标记，也不能让它参与断行
        return `MATHSTASH${math.length - 1}END`;
      };

      // 公式先抽走，再处理 wikilink，最后才交给 markdown-it —— 顺序不能换：
      // wikilink 的替换结果含 `<` 与 `]`，先替换会让 markdown 把它们当标记解析
      const stashed = (src ?? '')
        .replace(BLOCK_MATH, (_m, expr: string) => stashMath(expr, true))
        .replace(INLINE_MATH, (_m, expr: string) => stashMath(expr, false));

      const wikilinks: { target: string; label: string }[] = [];
      const staged = stashed.replace(WIKILINK, (_m, raw: string) => {
        const parsed = parseWikilink(raw);
        wikilinks.push(parsed);
        return `WIKISTASH${wikilinks.length - 1}END`;
      });

      let html = md.render(staged);

      html = html.replace(/MATHSTASH(\d+)END/g, (_m, idx: string) => {
        const item = math[Number(idx)];
        if (!item) return '';
        try {
          return katex.renderToString(item.expr.trim(), {
            displayMode: item.display,
            // 公式坏掉时显示红色原文而不是抛错：一篇笔记里有个笔误不该让整篇打不开
            throwOnError: false,
          });
        } catch {
          return `<code>${escapeHtml(item.expr)}</code>`;
        }
      });

      html = html.replace(/WIKISTASH(\d+)END/g, (_m, idx: string) => {
        const item = wikilinks[Number(idx)];
        if (!item) return '';
        // 用 span 不用 a：M2 还不做跳转，做成 a 点了没反应反而像坏了
        return `<span class="wikilink" data-wikilink="${escapeHtml(item.target)}">${escapeHtml(item.label)}</span>`;
      });

      return html;
    },
  };
}
