/**
 * 左滑抽屉：笔记目录 + 搜索（当前只按文件名过滤；内容搜索是 M4 的索引工作）。
 *
 * 列表用虚拟滚动：一万篇笔记时只渲染可视区附近的几十行。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { visibleWindow } from './virtual';
import { useNotes } from './store';
import { displayTitle } from '@core/paths';

const ROW_H = 56;

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${sameYear ? '' : `${d.getFullYear()}-`}${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function Drawer(): React.JSX.Element {
  const open = useNotes((s) => s.drawerOpen);
  const setDrawer = useNotes((s) => s.setDrawer);
  const setQuery = useNotes((s) => s.setQuery);
  const query = useNotes((s) => s.query);
  const current = useNotes((s) => s.current);
  const meta = useNotes((s) => s.meta);
  const openNote = useNotes((s) => s.openNote);
  const createNote = useNotes((s) => s.createNote);

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // 过滤只走内存清单：零 IO
  const rows = useNotes((s) => s.visible());

  const win = useMemo(
    () => visibleWindow({ scrollTop, viewportHeight, rowHeight: ROW_H, total: rows.length }),
    [scrollTop, viewportHeight, rows.length],
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = (): void => setViewportHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const slice = rows.slice(win.start, win.end);

  return (
    <>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={() => setDrawer(false)} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="head">
          <input
            type="search"
            placeholder="搜索笔记名（只支持简单的与关系）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="icon-btn" onClick={() => setDrawer(false)} aria-label="关闭">
            ✕
          </button>
        </div>

        <button className="new-note" onClick={() => void createNote()}>
          ＋ 新建笔记
        </button>

        {rows.length === 0 ? (
          <div className="empty">
            <div>{query ? '没有匹配的笔记' : '还没有笔记'}</div>
            {!query && <div>同步功能就绪后，这里会列出仓库里的全部笔记</div>}
          </div>
        ) : (
          <div
            className="list"
            ref={listRef}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            <div style={{ height: win.totalHeight, position: 'relative' }}>
              <div style={{ position: 'absolute', top: win.offsetY, left: 0, right: 0 }}>
                {slice.map((path) => (
                  <div
                    key={path}
                    className={`row ${path === current ? 'active' : ''}`}
                    style={{ height: ROW_H }}
                    onClick={() => void openNote(path)}
                  >
                    <div className="name">{displayTitle(path)}</div>
                    <div className="meta">{formatTime(meta.notes[path]?.mtime ?? 0)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
