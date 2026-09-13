import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { CapacitorFileStore } from '@core/fs/capacitor-fs';
import { MemoryFileStore } from '@core/fs/memory-fs';
import type { FileStore } from '@core/fs/store';
import { displayTitle, sanitizeNoteName } from '@core/paths';
import { Drawer } from './Drawer';
import { decideBack } from './back-stack';
import { ContentBar } from './ContentBar';
import { useEdgeSwipe } from './useEdgeSwipe';
import { prefetchMarkdown } from './md';
import { watchKeyboardHeight } from './viewport';
import { SyncSheet } from './SyncSheet';
import { FindBar } from './FindBar';
import { findMatches, matchLabel, replaceAllLiteral, replaceOne, stepIndex } from './find';
import { Editor } from './Editor';
import { EmptyReader, Reader } from './Reader';
import { useNotes } from './store';

/** 浏览器里没有 Capacitor 桥，用内存文件层顶上，方便开发与端到端自测。 */
function pickStore(): FileStore {
  return Capacitor.isNativePlatform() ? new CapacitorFileStore() : new MemoryFileStore();
}

interface AppProps {
  /** 只给测试用：注入替身文件层（不传则按平台自动选择）。 */
  store?: FileStore;
}

export function App({ store: injected }: AppProps = {}): React.JSX.Element {
  const ready = useNotes((s) => s.ready);
  const init = useNotes((s) => s.init);
  const current = useNotes((s) => s.current);
  const content = useNotes((s) => s.content);
  const mode = useNotes((s) => s.mode);
  const dirty = useNotes((s) => s.dirty);
  const error = useNotes((s) => s.error);
  const toast = useNotes((s) => s.toast);
  const scrollRatio = useNotes((s) => s.scrollRatio);
  const setDrawer = useNotes((s) => s.setDrawer);
  const setMode = useNotes((s) => s.setMode);
  const setContent = useNotes((s) => s.setContent);
  const saveNote = useNotes((s) => s.saveNote);
  const renameNote = useNotes((s) => s.renameNote);
  const deleteNote = useNotes((s) => s.deleteNote);
  const setScrollRatio = useNotes((s) => s.setScrollRatio);
  const dismissError = useNotes((s) => s.dismissError);
  const syncStage = useNotes((s) => s.syncStage);
  const copyCurrentNote = useNotes((s) => s.copyCurrentNote);

  const ui = useNotes((s) => s.ui);
  const setUi = useNotes((s) => s.setUi);
  const [toastVisible, setToastVisible] = useState(false);

  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  /**
   * 阅读态实际标出来的命中数（见 Reader 的 onMarked）。编辑态不用它 —— 编辑器是
   * 直接对源文做匹配，源文里有多少处就是多少处。
   */
  const [markedCount, setMarkedCount] = useState(0);

  const matches = useMemo(() => findMatches(content, query, { caseSensitive }), [content, query, caseSensitive]);
  // 阅读态以 DOM 里的实际标记数为准，避免"共 5 处却只跳得到 3 处"
  const total = mode === 'read' ? markedCount : matches.length;
  const currentMatch = matches[clampIndex(findIndex, total)] ?? null;

  // 查询或匹配数一变就回到第一处：不然停在旧的第 7 处、而新查询只有 2 处，会跳到奇怪的位置
  useEffect(() => {
    setFindIndex(0);
  }, [query, caseSensitive]);

  // 切笔记时把查找整个收掉：留着会在新笔记上莫名其妙高亮，用户还以为内容坏了
  useEffect(() => {
    setQuery('');
    setReplaceText('');
    setFindIndex(0);
  }, [current]);

  const step = (delta: number): void => setFindIndex((i) => stepIndex(i, total, delta));

  const replaceCurrent = (): void => {
    if (!currentMatch) return;
    const next = replaceOne(content, currentMatch, replaceText);
    setContent(next);
    // 替换后当前项的位置会变（长度不一样），重新从第一处开始最不容易出错
    setFindIndex(0);
  };

  const replaceEvery = (): void => {
    if (!query) return;
    setContent(replaceAllLiteral(content, query, replaceText, { caseSensitive }));
    setFindIndex(0);
  };

  useEffect(() => {
    void init(injected ?? pickStore());
    // 启动后就把渲染管线拉下来：几百 KB 的包，等用户点开笔记时通常已经就位，
    // 避免第一篇先闪一下纯文本。失败也不影响使用（阅读态会一直走纯文本回退）。
    prefetchMarkdown();
  }, [init, injected]);

  useEffect(() => {
    if (!toast) return;
    setToastVisible(true);
    const t = setTimeout(() => setToastVisible(false), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  /**
   * Android 返回键。
   *
   * 不处理的话它走 Capacitor 默认行为 = **直接退出应用**，于是"抽屉开着按返回"
   * 和"想关个弹层"都会把整个应用关掉 —— 用户实际遇到的就是这个。
   *
   * 优先级见 `back-stack.ts`：弹层 → 查找栏 → 抽屉 → 编辑态 → 交给系统退出。
   */
  useEffect(() => {
    let handle: { remove(): Promise<void> } | undefined;
    void CapApp.addListener('backButton', () => {
      const st = useNotes.getState();
      const action = decideBack({
        rename: st.ui.rename,
        sync: st.ui.sync,
        find: st.ui.find,
        menu: st.ui.menu,
        drawer: st.drawerOpen,
        editing: st.mode === 'edit',
      });
      if (action.kind === 'exit') {
        void CapApp.exitApp();
        return;
      }
      switch (action.layer) {
        case 'menu':
        case 'rename':
        case 'sync':
        case 'find':
          st.setUi(action.layer, false);
          break;
        case 'drawer':
          st.setDrawer(false);
          break;
        case 'editor':
          // 退回阅读态前**必须先保存**：用户以为"退出来了"，实际改动还在内存里的话，
          // 再按一次返回就把应用关了，改动一起没。保存是异步的，所以先存再切。
          void (async () => {
            if (useNotes.getState().dirty) await useNotes.getState().saveNote();
            useNotes.getState().setMode('read');
          })();
          break;
      }
    }).then((h) => {
      handle = h;
    });
    return () => {
      void handle?.remove();
    };
  }, []);

  const toggleMode = async (): Promise<void> => {
    if (mode === 'edit' && dirty) await saveNote();
    setMode(mode === 'edit' ? 'read' : 'edit');
  };

  const startRename = (): void => {
    if (!current) return;
    setUi('rename', true);
  };

  // 键盘占位：把"被键盘遮住的高度"写进 --bottom-blocked（见 styles.css）。
  // 原生侧（MainActivity）已经把 WebView 顶上去，这里是 Android 14 及以下 + 老 WebView
  // 那一格的唯一让位来源；两层不会叠加 —— 原生撑短后可视视口跟着变小，算出来自然接近 0。
  useEffect(
    () => watchKeyboardHeight((kb) => document.documentElement.style.setProperty('--kb', `${kb}px`)),
    [],
  );

  // 左缘右滑打开抽屉、抽屉上左滑收回（都跟手）。事件挂在 document 上，见 hook 内部注释。
  useEdgeSwipe();

  return (
    <div className="app">
      <header className="bar">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="打开目录">
          ☰
        </button>
        <div
          className={`title ${current ? '' : 'empty'}`}
          onClick={startRename}
          role={current ? 'button' : undefined}
          aria-label={current ? '笔记标题，点击可重命名' : undefined}
        >
          {current ? displayTitle(current) : 'mochi'}
          {dirty ? ' •' : ''}
        </div>
        <button className="pill" onClick={() => setUi('sync', true)} title="同步设置与拉取">
          {syncStage || '同步'}
        </button>
        {current && (
          <button className="pill" onClick={() => setUi('find', !ui.find)} title="查找（编辑态还能替换）">
            查找
          </button>
        )}
        {/*
          更多操作。做成一排竖点（而不是把"复制"直接摊成一个按钮）是为了**留出扩展位**：
          往后加"导出""分享给…"这类操作时不必再动顶栏布局，也不必重新教育用户去哪找。
        */}
        <button
          className="icon-btn menu-toggle"
          onClick={() => setUi('menu', !ui.menu)}
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={ui.menu}
        >
          ⋮
        </button>
      </header>

      {/* 点菜单以外任何地方都收掉。用一次性监听而不是常驻：只在开着时挂，省得每次点击都过一遍 */}
      {ui.menu && (
        <>
          <div className="menu-scrim" onClick={() => setUi('menu', false)} />
          <div className="menu" role="menu">
            <button
              className="menu-item"
              role="menuitem"
              disabled={!current || !content.trim()}
              onClick={() => void copyCurrentNote()}
            >
              复制当前笔记
              <span className="menu-hint">标题 + 正文，可直接粘贴</span>
            </button>
            <button
              className="menu-item"
              role="menuitem"
              disabled={!current || !content.trim()}
              onClick={() => void copyCurrentNote({ withTitle: false })}
            >
              复制当前笔记（不含标题）
              <span className="menu-hint">只要正文，避免标题重复</span>
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="error-bar">
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={dismissError}>知道了</button>
        </div>
      )}

      {ui.find && current && (
        <FindBar
          mode={mode}
          query={query}
          onQueryChange={setQuery}
          replaceText={replaceText}
          onReplaceTextChange={setReplaceText}
          matches={matches}
          index={findIndex}
          caseSensitive={caseSensitive}
          onToggleCase={() => setCaseSensitive((v) => !v)}
          onStep={step}
          onReplaceOne={replaceCurrent}
          onReplaceAll={replaceEvery}
          onClose={() => setUi('find', false)}
          label={matchLabel(total, findIndex, query)}
          autoFocus
        />
      )}

      <ContentBar />

      <main className="main">
        {ready && !current && <EmptyReader />}
        {current && mode === 'read' && (
          <Reader
            content={content}
            initialRatio={scrollRatio}
            onRatioChange={setScrollRatio}
            query={ui.find ? query : ''}
            findIndex={findIndex}
            onMarked={setMarkedCount}
          />
        )}
        {current && mode === 'edit' && (
          <Editor content={content} onChange={setContent} initialRatio={scrollRatio} match={ui.find ? currentMatch : null} />
        )}

        {current && (
          <button className="fab" onClick={() => void toggleMode()} aria-label={mode === 'edit' ? '进入阅读' : '进入编辑'}>
            {mode === 'edit' ? '📖' : '✒️'}
          </button>
        )}

        <Drawer />
        {toastVisible && toast && <div className="toast">{toast}</div>}
      </main>

      {ui.sync && <SyncSheet onClose={() => setUi('sync', false)} />}

      {ui.rename && current && (
        <RenameDialog
          initial={displayTitle(current)}
          onCancel={() => setUi('rename', false)}
          onConfirm={async (next) => {
            setUi('rename', false);
            const name = sanitizeNoteName(next);
            if (name !== current) await renameNote(name);
          }}
          onDelete={async () => {
            setUi('rename', false);
            await deleteNote();
          }}
        />
      )}
    </div>
  );
}

interface RenameProps {
  initial: string;
  onCancel: () => void;
  onConfirm: (next: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

/** 顶栏标题点击后的重命名/删除弹层。删除必须二次确认。 */
function RenameDialog({ initial, onCancel, onConfirm, onDelete }: RenameProps): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="scrim open" onClick={onCancel}>
      <div
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          top: '22%',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {!confirmDelete ? (
          <>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>重命名笔记</div>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--line)',
                background: 'var(--bg-soft)',
                color: 'var(--fg)',
                fontSize: 15,
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="pill" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto', color: '#b3261e' }}>
                删除
              </button>
              <button className="pill" onClick={onCancel}>
                取消
              </button>
              <button className="pill" onClick={() => void onConfirm(value)}>
                确定
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>确定删除《{initial}》？</div>
            <div style={{ color: 'var(--fg-dim)', fontSize: 13, marginBottom: 14 }}>
              推送后电脑上的这篇也会消失（本地会先留一份备份）。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="pill" onClick={() => setConfirmDelete(false)}>
                再想想
              </button>
              <button className="pill" style={{ color: '#b3261e' }} onClick={() => void onDelete()}>
                确认删除
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 把索引夹进 [0, total)：换笔记、匹配数变少时索引可能越界。 */
function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(index, total - 1);
}
