import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CapacitorFileStore } from '@core/fs/capacitor-fs';
import { MemoryFileStore } from '@core/fs/memory-fs';
import type { FileStore } from '@core/fs/store';
import { displayTitle, sanitizeNoteName } from '@core/paths';
import { Drawer } from './Drawer';
import { useEdgeSwipe } from './useEdgeSwipe';
import { watchKeyboardHeight } from './viewport';
import { SyncSheet } from './SyncSheet';
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

  const [renaming, setRenaming] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    void init(injected ?? pickStore());
  }, [init, injected]);

  useEffect(() => {
    if (!toast) return;
    setToastVisible(true);
    const t = setTimeout(() => setToastVisible(false), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleMode = async (): Promise<void> => {
    if (mode === 'edit' && dirty) await saveNote();
    setMode(mode === 'edit' ? 'read' : 'edit');
  };

  const startRename = (): void => {
    if (!current) return;
    setRenaming(true);
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
        <button className="pill" onClick={() => setSyncOpen(true)} title="同步设置与拉取">
          {syncStage || '同步'}
        </button>
      </header>

      {error && (
        <div className="error-bar">
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={dismissError}>知道了</button>
        </div>
      )}

      <main className="main">
        {ready && !current && <EmptyReader />}
        {current && mode === 'read' && (
          <Reader content={content} initialRatio={scrollRatio} onRatioChange={setScrollRatio} />
        )}
        {current && mode === 'edit' && <Editor content={content} onChange={setContent} initialRatio={scrollRatio} />}

        {current && (
          <button className="fab" onClick={() => void toggleMode()} aria-label={mode === 'edit' ? '进入阅读' : '进入编辑'}>
            {mode === 'edit' ? '📖' : '✒️'}
          </button>
        )}

        <Drawer />
        {toastVisible && toast && <div className="toast">{toast}</div>}
      </main>

      {syncOpen && <SyncSheet onClose={() => setSyncOpen(false)} />}

      {renaming && current && (
        <RenameDialog
          initial={displayTitle(current)}
          onCancel={() => setRenaming(false)}
          onConfirm={async (next) => {
            setRenaming(false);
            const name = sanitizeNoteName(next);
            if (name !== current) await renameNote(name);
          }}
          onDelete={async () => {
            setRenaming(false);
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
