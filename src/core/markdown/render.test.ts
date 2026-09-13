/**
 * 渲染管线的单测。
 *
 * 重点不是"markdown 能不能渲染"（那是 markdown-it 的事），而是**公式不被 markdown 吃掉**
 * 与**占位符回填不出错**这两件自己写的逻辑 —— 它们出问题时会静默改坏内容，
 * 比如 `$a_b$` 变成斜体 a 加一个 b，不盯着看根本发现不了。
 */
import { describe, expect, it } from 'vitest';
import { createMarkdownRenderer, parseWikilink } from './render';

const r = createMarkdownRenderer();

describe('parseWikilink', () => {
  it('基本形态：目标是文件名，显示也是它', () => {
    expect(parseWikilink('某某笔记')).toEqual({ target: '某某笔记', label: '某某笔记' });
  });

  it('别名形态：显示用别名，目标仍是文件名', () => {
    expect(parseWikilink('某某笔记|点这里')).toEqual({ target: '某某笔记', label: '点这里' });
  });

  it('带标题：目标只取文件名部分，标题不进文件名', () => {
    expect(parseWikilink('某某笔记#某节')).toEqual({ target: '某某笔记', label: '某某笔记' });
  });

  it('带标题与别名：三者各归各位', () => {
    expect(parseWikilink('某某笔记#某节|别名')).toEqual({ target: '某某笔记', label: '别名' });
  });

  it('只有标题（指向本文档内的标题）时没有目标文件', () => {
    expect(parseWikilink('#某节')).toEqual({ target: '', label: '某节' });
  });

  it('两侧空格被裁掉', () => {
    expect(parseWikilink('  某某笔记  |  别名  ')).toEqual({ target: '某某笔记', label: '别名' });
  });
});

describe('公式', () => {
  it('行内公式的下划线不被 markdown 当成强调', () => {
    const html = r.render('设 $a_b$ 为常数');
    // 关键：出现 KaTeX 的类名，且**没有** <em>
    expect(html).toContain('katex');
    expect(html).not.toContain('<em>');
  });

  it('行内公式的星号不被当成强调', () => {
    const html = r.render('$a*b*c$ 与 $x*y$');
    expect(html).not.toContain('<em>');
    expect((html.match(/katex/g) ?? []).length).toBeGreaterThan(1);
  });

  it('块级公式跨行也能拿到', () => {
    const html = r.render('$$\n\\frac{1}{2}\n$$');
    expect(html).toContain('katex-display');
  });

  it('公式里的小于号不会被当成 HTML 标签（html:false 下不该出现裸标签）', () => {
    const html = r.render('当 $a < b$ 时');
    expect(html).toContain('katex');
    // 不该出现被解析出来的标签
    expect(html).not.toContain('<b>');
  });

  it('多个公式按各自的下标回填，不会串位', () => {
    const html = r.render('$x_1$ 和 $y_2$');
    // 两个 KaTeX 片段，且各自包含自己的变量
    expect((html.match(/katex/g) ?? []).length).toBeGreaterThan(1);
    expect(html).not.toContain('MATHSTASH');
  });

  it('坏公式不抛错，退化成代码片段（一篇里有笔误不该让整篇打不开）', () => {
    const html = r.render('$\\frac{1}{$ 后面还有正文');
    expect(html).toContain('后面还有正文');
  });
});

describe('内链', () => {
  it('渲染成带目标名的 span，且不是可点的 a（M2 还不做跳转）', () => {
    const html = r.render('见 [[某某笔记]] 一节');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-wikilink="某某笔记"');
    expect(html).not.toContain('<a ');
  });

  it('别名只影响显示文字', () => {
    const html = r.render('[[某某笔记|点这里]]');
    expect(html).toContain('data-wikilink="某某笔记"');
    expect(html).toContain('>点这里<');
  });

  it('多个内链各自回填，不会串位', () => {
    const html = r.render('[[甲]] 与 [[乙]]');
    expect(html).toContain('data-wikilink="甲"');
    expect(html).toContain('data-wikilink="乙"');
    expect(html).not.toContain('WIKISTASH');
  });

  it('目标名里的引号被转义，不会撑破属性', () => {
    const html = r.render('[[a"b]]');
    expect(html).not.toContain('data-wikilink="a"b"');
  });

  it('内链与公式同时出现时互不干扰', () => {
    const html = r.render('[[某某笔记]] 里写了 $a_b$');
    expect(html).toContain('data-wikilink="某某笔记"');
    expect(html).toContain('katex');
    expect(html).not.toContain('STASH');
  });
});

describe('基础渲染与安全', () => {
  it('标题、列表、表格、代码块都能渲染', () => {
    expect(r.render('# 标题')).toContain('<h1>');
    expect(r.render('- 一项')).toContain('<li>');
    expect(r.render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
    expect(r.render('```\ncode\n```')).toContain('<code>');
  });

  it('单个换行就断行（用户明确要软换行）', () => {
    expect(r.render('第一行\n第二行')).toContain('<br>');
  });

  it('不解析内联 HTML：`<b>` 原样转义，不进 DOM', () => {
    const html = r.render('<b>不该加粗</b>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('链接都带上 rel=noopener noreferrer', () => {
    // 从前这条断言的是 `target="_blank"`。**行为已经改了**：外链不再直接跳转，
    // 而是等确认弹层里点过"打开"再走，所以 `target` 不再设置（见下面那一组测试）。
    // `rel` 仍然要留：确认之后那次导航是普通的同窗口跳转，断开 opener 依然有意义。
    expect(r.render('[某站](https://example.com)')).toContain('rel="noopener noreferrer"');
  });

  it('空内容不抛错', () => {
    expect(r.render('')).toBe('');
  });
});

describe('外链不直接跳转，等确认', () => {
  it('http 链接换成 data-external，href 拿掉', () => {
    const html = r.render('[看这个](https://example.com/a?b=1)');
    expect(html).toContain('data-external="https://example.com/a?b=1"');
    // href 必须是 `#`：留着真地址的话，任何一处漏掉拦截就变成静默跳走
    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="https://example.com');
    // 也不该再有 target=_blank —— 打开由确认之后的那次导航负责
    expect(html).not.toContain('target="_blank"');
  });

  it('http:// 与 mailto: 也算外链', () => {
    expect(r.render('[a](http://example.com)')).toContain('data-external="http://example.com"');
    expect(r.render('[b](mailto:x@example.com)')).toContain('data-external="mailto:x@example.com"');
  });

  it('内链（wikilink）不受影响', () => {
    const html = r.render('见 [[某某笔记]]');
    expect(html).toContain('data-wikilink="某某笔记"');
    expect(html).not.toContain('data-external');
  });

  it('纯锚点不算外链（它本来就该在页内跳）', () => {
    const html = r.render('[跳到某处](#某处)');
    expect(html).not.toContain('data-external');
  });

  it('相对链接不算外链（笔记库内部路径）', () => {
    const html = r.render('[别的笔记](别的笔记.md)');
    expect(html).not.toContain('data-external');
  });
});
