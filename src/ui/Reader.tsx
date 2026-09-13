/**
 * 阅读态：markdown 渲染 + 公式 + 内链跳转。
 *
 * 渲染是**异步就绪**的（管线懒加载，见 md.ts）。未就绪时先按纯文本显示 ——
 * 让用户立刻看到内容，而不是先看一个转圈。
 *
 * 内链跳转用**事件委托**（在容器上监听一次）而不是给每个 span 挂 onClick：
 * 渲染结果是 `dangerouslySetInnerHTML` 塞进去的，React 管不到里面的节点，
 * 每次重新渲染都要重新绑定；委托只绑一次，且新增的内链自动生效。
 */
import { useEffect, useRef } from 'react';
import { useNotes } from './store';
import { useMarkdownRenderer } from './md';
import { resolveWikilink } from './wikilink';
import { markMatches } from './mark-matches';

interface Props {
  content: string;
  initialRatio: number;
  onRatioChange: (ratio: number) => void;
  /** 查找词（空串 = 没在查找） */
  query: string;
  /** 当前第几处命中 */
  findIndex: number;
  /**
   * 实际标出来的命中数。
   *
   * 为什么不让查找栏直接用源文里的匹配数：阅读态查的是**渲染后**的文字，
   * 而源文里的 `#`、`*`、`|` 这些标记符号渲染后就没了。同一个词在两边的命中数
   * 可能不一样，报源文的数字会让用户看到"共 5 处"却只跳得到 3 处。
   */
  onMarked: (count: number) => void;
}

export function Reader({ content, initialRatio, onRatioChange, query, findIndex, onMarked }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const renderer = useMarkdownRenderer();
  const html = renderer ? renderer.render(content) : '';
  const openNote = useNotes((s) => s.openNote);
  const order = useNotes((s) => s.order);
  const setError = useNotes((s) => s.setError);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max > 0 ? max * Math.min(1, Math.max(0, initialRatio)) : 0;
    // 只在内容切换时定位。**不能把渲染结果放进依赖**：渲染器就绪那一刻 HTML 会变，
    // 但内容没变，此时重新定位会把用户已经滚动到的位置拉回去。
  }, [content, initialRatio]);

  /**
   * 查找高亮 + 定位。
   *
   * 依赖里带 `html`：渲染器就绪、HTML 换了一套的时候，标记得重打一遍，
   * 否则用户会看到"高亮突然全没了"。
   *
   * `onMarked` **故意不放依赖**，走 ref：它多半是调用方的内联箭头函数，每次渲染
   * 都是新的。而 App 订阅了 `scrollRatio`（滚动时高频变），内联函数会让这个 effect
   * 每滚一下就重跑 —— 重跑就会把当前项 `scrollIntoView` 一次，结果是用户根本滚不动。
   */
  const onMarkedRef = useRef(onMarked);
  onMarkedRef.current = onMarked;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const res = markMatches(el, query, findIndex);
    onMarkedRef.current(res.marked);
    if (!query) return;
    const current = el.querySelector('mark[data-find-current]');
    // 用 scrollIntoView 而不是算偏移：阅读态是任意 HTML（标题、列表、表格都可能有），
    // 算偏移得考虑每种块级元素的 margin，交给浏览器最省事也最准。
    //
    // 两处防御都不是多余的：
    //  - 元素可能不存在（查了但一处都没标上，比如词只出现在代码块里）；
    //  - `scrollIntoView` 本身可能不存在（jsdom 就没实现它）。直接调用会抛错，
    //    而这是 effect 里的异常 —— 会把**整个 Reader 卸载掉**，表现成"一查找正文就没了"。
    if (typeof current?.scrollIntoView === 'function') current.scrollIntoView({ block: 'center' });
  }, [html, query, findIndex]);

  const handleScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    onRatioChange(max > 0 ? el.scrollTop / max : 0);
  };

  /** 点内链：解析出目标就跳，解析不出就明说，不要默默什么都不做。 */
  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null;
    const span = target?.closest?.('[data-wikilink]');
    if (!span) return;
    const raw = span.getAttribute('data-wikilink') ?? '';
    const hit = resolveWikilink(raw, order);
    if (hit) {
      void openNote(hit.path);
      return;
    }
    setError(`内链指向的笔记不在仓库里：《${raw}》`);
  };

  return (
    <div className="reader" ref={ref} onScroll={handleScroll} onClick={handleClick}>
      {renderer ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        // 回退保持换行语义（与渲染管线的 breaks: true 一致），否则整篇会挤成一行
        <div className="md md-plain">{content}</div>
      )}
    </div>
  );
}

/** 空态：还没有打开任何笔记。 */
export function EmptyReader(): React.JSX.Element {
  const ready = useNotes((s) => s.ready);
  const loadStage = useNotes((s) => s.loadStage);
  const openingNote = useNotes((s) => s.openingNote);
  if (openingNote) {
    return (
      <div className="empty">
        <div>正在下载这篇笔记…</div>
      </div>
    );
  }
  return (
    <div className="empty">
      <div>{ready ? '从左上角打开笔记，或新建一篇' : loadStage || '启动中…'}</div>
    </div>
  );
}
