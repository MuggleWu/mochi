/**
 * 内容下载进度条（L1/L2）。
 *
 * 为什么值得常驻一条：首启只下最近 300 篇，用户需要知道"后台还在补"以及"还差多少"，
 * 否则搜不到某篇内容时会以为坏了。下载完自动消失，不占地方。
 */
import { useNotes } from './store';

export function ContentBar(): React.JSX.Element | null {
  const pullStage = useNotes((s) => s.pullStage);
  const done = useNotes((s) => s.pullDone);
  const total = useNotes((s) => s.pullTotal);
  const pending = useNotes((s) => s.pendingContent);
  const paused = useNotes((s) => s.pullPaused);
  const pauseContent = useNotes((s) => s.pauseContent);
  const pullContent = useNotes((s) => s.pullContent);

  const running = pullStage !== '';
  // 三种情况才显示：正在拉、暂停着（等用户决定继不继续）、有欠账要提醒。
  // 其余情况（下载完、根本不欠）一律不占地方 —— 常态是不显示。
  if (!running && !paused && pending === 0) return null;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="content-bar" role="status">
      <div className="content-bar-text">
        {running ? `${pullStage}…` : paused ? '内容下载已暂停' : '内容未下载完整'}
        <span className="content-bar-count">
          {running ? ` ${done}/${total}` : ` 还差 ${pending} 篇`}
        </span>
      </div>
      {running ? (
        <button className="content-bar-btn" onClick={pauseContent}>
          暂停
        </button>
      ) : (
        <button className="content-bar-btn" onClick={() => void pullContent()}>
          继续
        </button>
      )}
      {running && (
        <div className="content-bar-track">
          <div className="content-bar-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
