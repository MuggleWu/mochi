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

interface Props {
  content: string;
  initialRatio: number;
  onRatioChange: (ratio: number) => void;
}

export function Reader({ content, initialRatio, onRatioChange }: Props): React.JSX.Element {
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
