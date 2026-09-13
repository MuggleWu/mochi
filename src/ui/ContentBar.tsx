/**
 * 内容下载进度条（L1/L2）。
 *
 * 为什么值得常驻一条：首启只下最近 300 篇，用户需要知道"后台还在补"以及"还差多少"，
 * 否则搜不到某篇内容时会以为坏了。下载完自动消失，不占地方。
 */
import { useEffect, useState } from 'react';
import { humanizeWait } from '@core/net/github';
import { useNotes } from './store';

/**
 * 每秒重渲染一次，只为了把倒计时走起来。
 *
 * `at` 为 0（没有排着自动续下）时不起定时器 —— 常态是不显示的，别白跑一个 interval。
 */
function useCountdownText(at: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at <= 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  if (at <= 0) return '';
  return humanizeWait(Math.max(0, at - now));
}

export function ContentBar(): React.JSX.Element | null {
  const pullStage = useNotes((s) => s.pullStage);
  const done = useNotes((s) => s.pullDone);
  const total = useNotes((s) => s.pullTotal);
  const pending = useNotes((s) => s.pendingContent);
  const paused = useNotes((s) => s.pullPaused);
  const resumeAt = useNotes((s) => s.pullResumeAt);
  const pauseContent = useNotes((s) => s.pauseContent);
  const pullContent = useNotes((s) => s.pullContent);
  const waitText = useCountdownText(resumeAt);

  const running = pullStage !== '';
  const autoResume = !running && resumeAt > 0;
  // 四种情况才显示：正在拉、排着自动续下、暂停着（等用户决定继不继续）、有欠账要提醒。
  // 其余情况（下载完、根本不欠）一律不占地方 —— 常态是不显示。
  if (!running && !autoResume && !paused && pending === 0) return null;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const label = running
    ? `${pullStage}…`
    : autoResume
      ? `额度用完，${waitText}后自动接着下`
      : paused
        ? '内容下载已暂停'
        : '内容未下载完整';

  return (
    <div className="content-bar" role="status">
      <div className="content-bar-text">
        {label}
        <span className="content-bar-count">
          {running ? ` ${done}/${total}` : ` 还差 ${pending} 篇`}
        </span>
      </div>
      {running ? (
        <button className="content-bar-btn" onClick={pauseContent}>
          暂停
        </button>
      ) : (
        // 排着自动续下时按钮是"立刻开始"：等不及的用户不用干等那一刻
        <button className="content-bar-btn" onClick={() => void pullContent()}>
          {autoResume ? '立即继续' : '继续'}
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
