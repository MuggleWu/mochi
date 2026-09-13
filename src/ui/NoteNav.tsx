/**
 * 阅读态的「上一篇 / 下一篇」按钮。
 *
 * 顺序就是列表本身的顺序（最近改的在前），所以「下一篇」= 列表里往更早的方向走 ——
 * 与用户在抽屉列表里往下滚的直觉一致。
 *
 * 到头时按钮**留着但置灰**，而不是隐藏：位置固定的按钮一点就有反应、还能看出"到头了"，
 * 忽隐忽现反而会让人找不到。
 */
import { useNotes } from './store';

export function NoteNav(): React.JSX.Element | null {
  const current = useNotes((s) => s.current);
  const mode = useNotes((s) => s.mode);
  const order = useNotes((s) => s.order);
  const openNeighbor = useNotes((s) => s.openNeighbor);

  if (!current || mode !== 'read') return null;

  const at = order.indexOf(current);
  // 当前这篇不在列表里（理论上不该发生）：不如不显示，免得两个键都失灵
  if (at < 0) return null;

  const hasPrev = at > 0;
  const hasNext = at < order.length - 1;

  return (
    <div className="note-nav">
      <button
        className="note-nav-btn"
        onClick={() => void openNeighbor(-1)}
        disabled={!hasPrev}
        aria-label="上一篇"
        title="上一篇"
      >
        ←
      </button>
      <button
        className="note-nav-btn"
        onClick={() => void openNeighbor(1)}
        disabled={!hasNext}
        aria-label="下一篇"
        title="下一篇"
      >
        →
      </button>
    </div>
  );
}
