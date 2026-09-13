// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clearFindMarks, markMatches } from './mark-matches';

function mount(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** 把标记拆掉后的可见文字（用来确认"标记不改变内容"）。 */
const plain = (el: HTMLElement): string => el.textContent ?? '';

describe('阅读态标记', () => {
  it('标出命中，文字内容一个字符都不变', () => {
    const el = mount('<p>供应链管理与供应链优化</p>');
    const before = plain(el);
    const res = markMatches(el, '供应链', 0);
    expect(res.marked).toBe(2);
    expect(plain(el)).toBe(before);
    expect(el.querySelectorAll('mark[data-find]')).toHaveLength(2);
  });

  it('当前项有单独的标记', () => {
    const el = mount('<p>甲方乙方甲方</p>');
    markMatches(el, '甲方', 1);
    const current = el.querySelectorAll('mark[data-find-current]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('甲方');
    // 第二处（下标 1）在后面的位置
    expect(el.textContent!.lastIndexOf('甲方')).toBe(4);
  });

  it('重复查找不会让 DOM 越滚越大', () => {
    const el = mount('<p>测试测试测试</p>');
    for (let i = 0; i < 5; i += 1) markMatches(el, '测试', i % 3);
    // 每次先清再标，所以始终是 3 个
    expect(el.querySelectorAll('mark[data-find]')).toHaveLength(3);
    expect(plain(el)).toBe('测试测试测试');
  });

  it('查询为空时只做清理', () => {
    const el = mount('<p>测试</p>');
    markMatches(el, '测', 0);
    expect(el.querySelectorAll('mark[data-find]')).toHaveLength(1);
    markMatches(el, '', 0);
    expect(el.querySelectorAll('mark[data-find]')).toHaveLength(0);
  });

  it('跨文本节点的文字不受影响，也不会漏掉后面的节点', () => {
    // 一个词被 <strong> 切开时，搜整词不该崩，后半段也要能单独被搜到
    const el = mount('<p>供<strong>应</strong>链 与 供应链</p>');
    const res = markMatches(el, '供应', 0);
    // 第一处被标签切开，只有完整的第二处能标上
    expect(res.marked).toBe(1);
    expect(plain(el)).toBe('供应链 与 供应链');
  });

  it('代码块里的命中跳过（黄底会吃掉深色背景上的字）', () => {
    const el = mount('<p>正文里的 foo</p><pre><code>foo bar</code></pre>');
    const res = markMatches(el, 'foo', 0);
    expect(res.marked).toBe(1);
    expect(el.querySelector('pre')!.querySelectorAll('mark')).toHaveLength(0);
  });

  it('行内代码同样跳过', () => {
    const el = mount('<p>用 <code>npm run</code> 跑起来</p>');
    expect(markMatches(el, 'npm', 0).marked).toBe(0);
    expect(markMatches(el, '跑起来', 0).marked).toBe(1);
  });

  it('公式跳过（拆开 katex 的内部结构可能把公式弄坏）', () => {
    const el = mount('<p>公式 <span class="katex">x</span> 后面</p>');
    expect(markMatches(el, 'x', 0).marked).toBe(0);
    expect(markMatches(el, '后面', 0).marked).toBe(1);
  });

  it('大小写不敏感', () => {
    const el = mount('<p>Hello HELLO</p>');
    expect(markMatches(el, 'hello', 0).marked).toBe(2);
  });

  it('清理后能连跨块查找（normalize 把拆散的文本节点合回去了）', () => {
    const el = mount('<p>abcd</p>');
    markMatches(el, 'bc', 0); // 拆成 a | bc | d
    clearFindMarks(el);
    // 不 normalize 的话 "abcd" 会一直是 3 个文本节点，跨块搜索会漏
    expect(el.textContent).toBe('abcd');
    expect(markMatches(el, 'abcd', 0).marked).toBe(1);
  });

  it('current 越界时不崩、只不标当前项', () => {
    const el = mount('<p>短</p>');
    expect(() => markMatches(el, '短', 99)).not.toThrow();
    expect(el.querySelectorAll('mark[data-find-current]')).toHaveLength(0);
  });
});
