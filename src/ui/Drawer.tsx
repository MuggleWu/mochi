/**
 * 左滑抽屉：笔记目录 + 搜索。
 *
 * 搜索有三层反馈，用户不该等：
 * 1. 敲字即出**文件名命中**（只查内存清单，零 IO）
 * 2. 正文命中紧随其后（走内存倒排索引，零读盘）
 * 3. 命中的那几篇读正文生成**摘要**（只读命中的，最多 100 篇）
 *
 * 列表用虚拟滚动：一万篇笔记时只渲染可视区附近的几十行。
 * 行高固定（摘要可能被截断成一行），这样虚拟滚动不用做动态测高。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { visibleWindow } from './virtual';
import { useNotes } from './store';
import { displayTitle } from '@core/paths';
import { effectiveMtime, hasRealMtime, type NoteEntry } from '@core/sync/manifest';
import { drawerProgress } from './edge-swipe';
import type { SearchRow } from './search-view';

/** 行高固定：有摘要时是"标题 + 摘要"两行，虚拟滚动不必做动态测高。 */
/**
 * 每行的高度。**必须与 `styles.css` 的 `--row-h` 同值**（虚拟滚动按固定行高算
 * 总高度与位移，不一致会让滚动位置错乱）。
 *
 * 取这个值的依据是"标题要完整显示、不省略"：实测标题宽度分布，手机宽度下允许三行
 * 可覆盖 100%（最长的一个约 945px，两行装不下）。所以 = 3 行标题 + 一行时间/摘要。
 */
const ROW_H = 96;

/** 把摘要按命中区间切开，命中部分用 <mark> 标出来。 */
function Snippet({ text, hl }: { text: string; hl?: [number, number] }): React.JSX.Element {
  if (!hl) return <>{text}</>;
  const [from, to] = hl;
  return (
    <>
      {text.slice(0, from)}
      <mark>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${sameYear ? '' : `${d.getFullYear()}-`}${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 列表里的时间。
 *
 * 有真实修改时间就显示它；没有（还没整理历史，或那篇从没被改过）显示「时间未知」——
 * **不拿"下载时刻"冒充**，否则手机上会看到一堆"刚刚"，反而更没法定位。
 */
function entryTime(e: NoteEntry | undefined): string {
  if (!hasRealMtime(e)) return '时间未知';
  return formatTime(effectiveMtime(e));
}

export function Drawer(): React.JSX.Element {
  const open = useNotes((s) => s.drawerOpen);
  const setDrawer = useNotes((s) => s.setDrawer);
  const setSearchQuery = useNotes((s) => s.setSearchQuery);
  const query = useNotes((s) => s.query);
  const rows = useNotes((s) => s.rows);
  const indexing = useNotes((s) => s.indexing);
  const indexed = useNotes((s) => s.indexed);
  const current = useNotes((s) => s.current);
  const meta = useNotes((s) => s.meta);
  const openNote = useNotes((s) => s.openNote);

  const offset = useNotes((s) => s.drawerOffset);
  const setDrawerWidth = useNotes((s) => s.setDrawerWidth);
  const width = useNotes((s) => s.drawerWidth);
  /** 拖动中（有偏移且抽屉开着）= 手指正在跟手，此时要关掉过渡 */
  const dragging = offset !== null && open;
  const createNote = useNotes((s) => s.createNote);

  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // CSS 里宽度是 min(84%, 380px)，JS 侧也有一份公式（手势开始时抽屉还没挂载、量不到）。
  // 挂载后实测一次，两边以后不会因为改 CSS 而悄悄错位。
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setDrawerWidth(el.getBoundingClientRect().width);
  }, [open, setDrawerWidth]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // 有查询时列表来自搜索结果（文件名命中 + 正文命中），无查询时就是全量清单
  const visible = useNotes((s) => s.visible());
  const showingSearch = query.trim() !== '';
  const rowOf = (path: string): SearchRow | undefined =>
    showingSearch ? rows.find((r) => r.path === path) : undefined;

  const win = useMemo(
    () => visibleWindow({ scrollTop, viewportHeight, rowHeight: ROW_H, total: visible.length }),
    [scrollTop, viewportHeight, visible.length],
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

  const slice = visible.slice(win.start, win.end);

  return (
    <>
      <div
        className={`scrim ${open ? 'open' : ''}`}
        style={dragging ? { opacity: drawerProgress(offset, width) } : undefined}
        onClick={() => setDrawer(false)}
      />
      <aside
        className={`drawer ${open ? 'open' : ''}${dragging ? ' dragging' : ''}`}
        ref={panelRef}
        aria-hidden={!open}
        style={offset === null ? undefined : { transform: `translateX(${offset}px)` }}
      >
        <div className="head">
          <input
            type="search"
            placeholder="搜索笔记名或内容"
            value={query}
            onChange={(e) => void setSearchQuery(e.target.value)}
          />
          <button className="icon-btn" onClick={() => setDrawer(false)} aria-label="关闭">
            ✕
          </button>
        </div>

        {showingSearch && indexing && (
          <div className="index-hint">正文索引建立中（已收录 {indexed} 篇）</div>
        )}

        <button className="new-note" onClick={() => void createNote()}>
          ＋ 新建笔记
        </button>

        {visible.length === 0 ? (
          <div className="empty">
            <div>{query ? '没有匹配的笔记' : '还没有笔记'}</div>
            {!query && <div>同步功能就绪后，这里会列出仓库里的全部笔记</div>}
            {query && indexing && <div>正文索引还在建，稍等一下再搜</div>}
          </div>
        ) : (
          <div
            className="list"
            ref={listRef}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            <div style={{ height: win.totalHeight, position: 'relative' }}>
              <div style={{ position: 'absolute', top: win.offsetY, left: 0, right: 0 }}>
                {slice.map((path) => {
                  const hit = rowOf(path);
                  return (
                    <div
                      key={path}
                      className={`row ${path === current ? 'active' : ''}`}
                      style={{ height: ROW_H }}
                      onClick={() => void openNote(path)}
                    >
                      <div className="name">{displayTitle(path)}</div>
                      {hit?.kind === 'content' && hit.snippet ? (
                        <div className="snippet">
                          <Snippet text={hit.snippet} {...(hit.hl ? { hl: hit.hl } : {})} />
                        </div>
                      ) : (
                        <div className="meta">{entryTime(meta.notes[path])}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
