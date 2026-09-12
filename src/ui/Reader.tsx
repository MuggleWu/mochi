/**
 * 阅读态：先做纯文本安全渲染（markdown 渲染管线是 M2 的工作）。
 *
 * 这里刻意不引入 markdown-it —— 先把"读写切换、位置保持、抽屉、新建保存"
 * 这条主链路跑通，渲染在 M2 接上 miki 已验证的管线（markdown-it + KaTeX）。
 */
import { useEffect, useRef } from 'react';
import { useNotes } from './store';

interface Props {
  content: string;
  initialRatio: number;
  onRatioChange: (ratio: number) => void;
}

export function Reader({ content, initialRatio, onRatioChange }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max > 0 ? max * Math.min(1, Math.max(0, initialRatio)) : 0;
    // 只在内容切换时定位
  }, [content, initialRatio]);

  const handleScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    onRatioChange(max > 0 ? el.scrollTop / max : 0);
  };

  const paragraphs = content.split(/\n{2,}/);

  return (
    <div className="reader" ref={ref} onScroll={handleScroll}>
      {paragraphs.map((block, i) => <Block key={i} text={block} />)}
    </div>
  );
}

function Block({ text }: { text: string }): React.JSX.Element {
  const trimmed = text.trim();
  if (!trimmed) return <p />;

  const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (heading) {
    const level = heading[1]!.length;
    const body = heading[2]!;
    if (level === 1) return <h1>{body}</h1>;
    if (level === 2) return <h2>{body}</h2>;
    return <h3>{body}</h3>;
  }

  if (trimmed.startsWith('```')) {
    const body = trimmed.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
    return (
      <pre>
        <code>{body}</code>
      </pre>
    );
  }

  const lines = trimmed.split('\n');
  if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
    return (
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l.replace(/^\s*[-*+]\s+/, '')}</li>
        ))}
      </ul>
    );
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return (
      <ol>
        {lines.map((l, i) => (
          <li key={i}>{l.replace(/^\s*\d+[.)]\s+/, '')}</li>
        ))}
      </ol>
    );
  }

  return <p>{lines.map((l, i) => <span key={i}>{l}{i < lines.length - 1 && <br />}</span>)}</p>;
}

/** 空态：还没有打开任何笔记。 */
export function EmptyReader(): React.JSX.Element {
  const ready = useNotes((s) => s.ready);
  const loadStage = useNotes((s) => s.loadStage);
  return (
    <div className="empty">
      <div>{ready ? '从左上角打开笔记，或新建一篇' : loadStage || '启动中…'}</div>
      {ready && <div>同步仓库的功能正在接入（M1/M2）</div>}
    </div>
  );
}
