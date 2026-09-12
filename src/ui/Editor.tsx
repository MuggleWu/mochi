/**
 * 编辑态：原生 textarea + 独立行号槽 + 软换行。
 *
 * 关键设计（本机实测结论，见项目设计文档第 7 节）：
 *   * 行号槽里第 i 个行号摆在 `i × 行高`，与浏览器画第 i 行的算式相同 → 行号不漂移；
 *   * 软换行的续行不占行号，自动留空档（与桌面编辑器一致）；
 *   * 跳转定位**不能**用 `scrollTop ÷ 行高`：软换行下它不是线性关系
 *     （实测 1800 行时漂移 1232px ≈ 56 行）。需要镜像测量，属于 M3 的工作。
 */
import { useEffect, useMemo, useRef } from 'react';

export const LINE_HEIGHT = 22;

interface Props {
  content: string;
  onChange: (next: string) => void;
  /** 初始滚动比例（0~1），用于读写态切换时保持位置。 */
  initialRatio?: number;
}

export function Editor({ content, onChange, initialRatio = 0 }: Props): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = useMemo(() => content.split('\n').length, [content]);

  // 行号槽跟随滚动（transform 平移，两侧永不脱节）
  useEffect(() => {
    const ta = taRef.current;
    const gutter = gutterRef.current;
    if (!ta || !gutter) return;
    const sync = (): void => {
      gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
    };
    sync();
    ta.addEventListener('scroll', sync, { passive: true });
    return () => ta.removeEventListener('scroll', sync);
  }, []);

  // 首次挂载按比例定位（读写态切换保持位置）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || initialRatio <= 0) return;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max > 0) ta.scrollTop = max * Math.min(1, Math.max(0, initialRatio));
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const numbers = useMemo(() => {
    const out: string[] = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) out[i] = String(i + 1);
    return out;
  }, [lineCount]);

  return (
    <div className="editor">
      <div className="gutter" aria-hidden="true">
        <div className="gutter-inner" ref={gutterRef}>
          {numbers.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
      </div>
      <textarea
        ref={taRef}
        value={content}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        placeholder="在这里写点什么…"
      />
    </div>
  );
}
