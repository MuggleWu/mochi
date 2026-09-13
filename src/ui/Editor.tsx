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
  /** 查找命中的字符区间；有值时自动选中并滚到可见处。 */
  match?: { start: number; end: number } | null;
}

/**
 * 一个字符下标在第几行（0 起）。
 *
 * 只按 `\n` 数，**不管软换行** —— 软换行的折行位置取决于宽度与字体，
 * 在 JS 里算不准。所以它只用来**估算**滚动位置（见下），不用来做精确定位。
 */
export function lineOfOffset(content: string, offset: number): number {
  let line = 0;
  const upTo = Math.max(0, Math.min(offset, content.length));
  for (let i = 0; i < upTo; i += 1) if (content[i] === '\n') line += 1;
  return line;
}

export function Editor({ content, onChange, initialRatio = 0, match = null }: Props): React.JSX.Element {
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

  /**
   * 跳到查找命中的那一处：选中它，并把它滚进可见范围。
   *
   * 选中用 `setSelectionRange` 而不是让调用方改 content —— 改 content 会把用户的
   * 编辑历史（撤销栈）搞乱，查找是"看"不是"改"。选中还有额外好处：手机上会出现
   * 选择手柄，用户立刻知道跳到哪了。
   *
   * 滚动位置**按行数比例估**，不按 `行号 × 行高`：这个 textarea 是软换行（设计文档
   * 第 7 节实测过，1800 行时按行高算会漂 1232px ≈ 56 行）。比例法在折行多少上会有
   * 误差，但方向一定对、且命中行一定落在可见区附近 —— 反正选中了，用户一眼能看到。
   * 真要精确得用镜像测量，那是另一件事，不值得为"跳转"付这个复杂度。
   */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !match) return;
    ta.setSelectionRange(match.start, match.end);
    const max = ta.scrollHeight - ta.clientHeight;
    if (max <= 0 || lineCount <= 1) return;
    const ratio = lineOfOffset(content, match.start) / (lineCount - 1);
    ta.scrollTop = max * Math.min(1, Math.max(0, ratio));
  }, [match, content, lineCount]);

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
