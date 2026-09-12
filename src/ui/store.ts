/**
 * 应用状态（zustand）。
 *
 * 性能纪律：列表与搜索**只读内存里的清单**；只有打开/保存某篇才碰文件。
 */
import { create } from 'zustand';
import type { FileStore } from '@core/fs/store';
import { MANIFEST_FILE } from '@core/fs/layout';
import { NotesRepo } from '@core/repo/notes-repo';
import { emptyMeta, deserializeMeta, serializeMeta, type Meta, type NoteEntry } from '@core/sync/manifest';
import { FLAG } from '@core/sync/manifest';
import { GithubClient, type FetchLike } from '@core/net/github';
import { fetchSnapshot, reconcileSnapshot } from '@core/sync/pull-metadata';
import { DEFAULT_SETTINGS, type Settings, isConfigured, loadSettings, saveSettings } from '@core/sync/settings';

export type Mode = 'read' | 'edit';

export interface NotesState {
  ready: boolean;
  loadStage: string;
  /** 按修改时间倒序的笔记列表（内存数组，供虚拟滚动使用）。 */
  order: string[];
  meta: Meta;
  current: string | null;
  content: string;
  mode: Mode;
  dirty: boolean;
  drawerOpen: boolean;
  query: string;
  /** 阅读位置（百分比），读写态切换时保持 */
  scrollRatio: number;
  error: string | null;
  toast: string | null;
  /** 同步配置（仓库/分支/令牌）。令牌只在内存与私有文件里。 */
  settings: Settings;
  /** 同步进行中的阶段文案（空串 = 空闲）。 */
  syncStage: string;
  /** 上次同步的摘要，用于顶栏提示。 */
  lastSyncNote: string;

  init(store: FileStore): Promise<void>;
  saveConfig(next: Settings): Promise<void>;
  /** 拉取远端元数据（阶段一）：一个请求拿到全部笔记，不下载内容。 */
  pullMetadata(): Promise<void>;
  createNote(): Promise<void>;
  openNote(path: string): Promise<void>;
  setContent(content: string): void;
  saveNote(): Promise<void>;
  renameNote(next: string): Promise<void>;
  deleteNote(): Promise<void>;
  setMode(mode: Mode): void;
  setDrawer(open: boolean): void;
  setQuery(q: string): void;
  setScrollRatio(r: number): void;
  dismissError(): void;
  /** 当前可见（被搜索过滤）的笔记列表。 */
  visible(): string[];
}

let store: FileStore | null = null;
let repo: NotesRepo | null = null;
/** 网络实现可注入，便于端到端自测（默认走真实 fetch）。 */
let fetchImpl: FetchLike | undefined;

const byMtimeDesc = (meta: Meta) => (a: string, b: string): number =>
  (meta.notes[b]?.mtime ?? 0) - (meta.notes[a]?.mtime ?? 0);

export const useNotes = create<NotesState>((set, get) => ({
  ready: false,
  loadStage: '启动中',
  order: [],
  meta: emptyMeta(),
  current: null,
  content: '',
  mode: 'read',
  dirty: false,
  drawerOpen: false,
  query: '',
  scrollRatio: 0,
  error: null,
  toast: null,
  settings: { ...DEFAULT_SETTINGS },
  syncStage: '',
  lastSyncNote: '',

  async init(fs: FileStore) {
    store = fs;
    repo = new NotesRepo(fs);
    set({ loadStage: '准备工作目录' });
    await repo.init();

    set({ loadStage: '读取本地清单' });
    const raw = await fs.readText(MANIFEST_FILE);
    let meta: Meta | null = null;
    if (raw) {
      try {
        meta = deserializeMeta(raw);
      } catch {
        meta = null; // 清单损坏 → 从磁盘重建（本地是缓存，允许重建）
      }
    }
    if (!meta) {
      set({ loadStage: '首次建立清单' });
      const built = await repo.buildManifest();
      meta = emptyMeta();
      meta.notes = built.notes;
      await fs.writeText(MANIFEST_FILE, serializeMeta(meta));
    }

    const settings = await loadSettings(fs);
    set({
      meta,
      order: Object.keys(meta.notes).sort(byMtimeDesc(meta)),
      ready: true,
      loadStage: '',
      settings,
      lastSyncNote: meta.lastSyncAt ? `上次同步 ${new Date(meta.lastSyncAt).toLocaleString()}` : '尚未同步过',
    });
  },

  async saveConfig(next) {
    if (!store) return;
    await saveSettings(store, next);
    const repoChanged = next.repo !== get().settings.repo || next.branch !== get().settings.branch;
    set({ settings: next, toast: '同步设置已保存' });
    if (repoChanged) set({ lastSyncNote: '仓库已更改，下次同步会重新建立清单' });
  },

  async pullMetadata() {
    const { settings, meta } = get();
    if (!isConfigured(settings)) {
      set({ error: '还没有配置同步仓库：请在设置里填写「仓库」与「访问令牌」' });
      return;
    }
    set({ syncStage: '连接 GitHub' });
    try {
      const client = new GithubClient({
        token: settings.token,
        repo: settings.repo,
        branch: settings.branch,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      set({ syncStage: '读取仓库结构' });
      const snap = await fetchSnapshot(client);
      set({ syncStage: '并入本地清单' });
      const next = reconcileSnapshot(meta, snap);
      const order = Object.keys(next.notes).sort(byMtimeDesc(next));
      set({
        meta: next,
        order,
        syncStage: '',
        lastSyncNote: `已读取 ${snap.files.length} 篇笔记的清单（内容按需下载）`,
        toast: `远端共 ${snap.files.length} 篇笔记`,
      });
      await persistManifest(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({ syncStage: '', error: hint ? `${message}\n${hint}` : message });
    }
  },

  async createNote() {
    if (!repo) return;
    const { meta } = get();
    const entry = await repo.create(meta, '');
    const next = { ...meta, notes: { ...meta.notes, [entry.path]: entry } };
    set({ meta: next, order: Object.keys(next.notes).sort(byMtimeDesc(next)), current: entry.path, content: '', mode: 'edit', dirty: true });
    await persistManifest(next);
  },

  async openNote(path: string) {
    if (!repo) return;
    const opened = await repo.open(path);
    if (!opened) {
      set({ error: `打不开《${path}》（本地还没有这篇内容）` });
      return;
    }
    set({ current: path, content: opened.content, mode: 'read', dirty: false, drawerOpen: false, scrollRatio: 0 });
  },

  setContent(content: string) {
    set({ content, dirty: true });
  },

  async saveNote() {
    if (!repo) return;
    const { current, content, meta } = get();
    if (!current) return;
    const entry = await repo.save(current, content);
    const previous = meta.notes[current];
    const merged: NoteEntry = {
      ...entry,
      remoteSha: previous?.remoteSha ?? '',
      syncedSha: previous?.syncedSha ?? '',
      flags: (previous?.flags ?? 0) | FLAG.DIRTY,
    };
    const next = { ...meta, notes: { ...meta.notes, [current]: merged } };
    set({ meta: next, order: Object.keys(next.notes).sort(byMtimeDesc(next)), dirty: false, toast: '已保存' });
    await persistManifest(next);
  },

  async renameNote(nextName) {
    if (!repo) return;
    const { current, meta } = get();
    if (!current || nextName === current) return;
    const r = await repo.rename(current, nextName);
    const notes = { ...meta.notes };
    delete notes[current];
    const previous = meta.notes[current];
    notes[r.to] = { ...r.entry, remoteSha: previous?.remoteSha ?? '', syncedSha: previous?.syncedSha ?? '', flags: (previous?.flags ?? 0) | FLAG.DIRTY };
    const next = { ...meta, notes };
    set({ meta: next, order: Object.keys(notes).sort(byMtimeDesc(next)), current: r.to, toast: `已改名为《${r.to}》` });
    await persistManifest(next);
  },

  async deleteNote() {
    if (!repo) return;
    const { current, meta } = get();
    if (!current) return;
    await repo.remove(current);
    const notes = { ...meta.notes };
    delete notes[current];
    const next = { ...meta, notes };
    set({ meta: next, order: Object.keys(notes).sort(byMtimeDesc(next)), current: null, content: '', toast: `《${current}》已移入回收站` });
    await persistManifest(next);
  },

  setMode(mode) {
    set({ mode });
  },
  setDrawer(drawerOpen) {
    set({ drawerOpen });
  },
  setQuery(query) {
    set({ query });
  },
  setScrollRatio(scrollRatio) {
    set({ scrollRatio });
  },
  dismissError() {
    set({ error: null });
  },

  visible() {
    const { order, query } = get();
    const q = query.trim().toLowerCase();
    if (!q) return order;
    return order.filter((p) => p.toLowerCase().includes(q));
  },
}));

/** 清单落盘（只写这一个文件；内容搜索索引是 M4 的事）。 */
async function persistManifest(meta: Meta): Promise<void> {
  if (!store) return;
  await store.writeText(MANIFEST_FILE, serializeMeta(meta));
}

/** 供端到端自测注入假网络（不传则走真实 fetch）。 */
export function __setFetchForTest(fake?: FetchLike): void {
  fetchImpl = fake;
}

/** 供端到端自测注入替身文件层（浏览器里没有 Capacitor 桥时也走它）。 */
export function __setFileStoreForTest(fs: FileStore): void {
  store = fs;
  repo = new NotesRepo(fs);
}
