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
import { shouldSnapOpen } from './edge-swipe';
import { DRAWER_SETTLE_MS } from './drawer-anim';

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
  /**
   * 抽屉的横向偏移（px）。约定 **0 = 全开，-drawerWidth = 全收起**，直接丢进 translateX。
   * null = 不在拖动/吸附中，由 CSS 按 drawerOpen 决定位置。
   */
  drawerOffset: number | null;
  /** 抽屉宽度（px）。CSS 与 JS 各有一份公式，挂载后实测校正。 */
  drawerWidth: number;
  /**
   * 单调递增的代数号：任何一次拖动或吸附都让它 +1，用来作废尚未落地的入场回调。
   *
   * 为什么需要：点按钮打开抽屉时先在屏幕外渲染一帧、下一帧才滑进来（否则过渡没有起点）。
   * 这两帧之间用户完全可能先拖了一下 —— 那时旧回调再去改偏移就会把用户的落点覆盖掉。
   * 真实症状是"轻轻一甩本该关闭，抽屉反而弹开"。用代数号比"判断偏移是否等于某个值"可靠，
   * 因为关闭吸附的目标值**也是** -width，会撞上。
   */
  drawerEnterSeq: number;
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
  /** 拖动/吸附期间设偏移；dragging=false 表示走过渡滑到落点。 */
  setDrawerOffset(offset: number, dragging?: boolean): void;
  setDrawerWidth(width: number): void;
  /** 松手落定：按速度与位置决定开合，并滑到落点。 */
  settleDrawer(release?: { velocity: number; travelled: number }): void;
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
  drawerOffset: null,
  drawerWidth: 0,
  drawerEnterSeq: 0,
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
      // 带上上次的提交与 ETag：远端没动时一个字节都不下载（实测省 20 倍时间）
      const snap = await fetchSnapshot(client, { lastCommit: meta.lastCommit, lastEtag: meta.treeEtag });
      if (!snap) {
        set({
          syncStage: '',
          lastSyncNote: '远端没有变化，无需下载',
          toast: '已是最新',
        });
        await persistManifest({ ...meta, lastSyncAt: Date.now() });
        return;
      }
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
  setDrawer(open) {
    // 点汉堡进来：从屏幕外滑到位。
    //
    // 用**过渡**而不是 CSS keyframe 动画，是有教训的：拖动期间要关掉动画，而松手时把
    // "拖动中"的标记一移除，animation-name 从 none 变回具名动画会被浏览器当成一段**新动画**
    // 重新开始 —— 面板先跳回屏幕外再滑进来，用户看到的就是"松手时抖动"。
    // 只留过渡就没有能被重启的东西。
    if (!open) {
      set({ drawerOpen: false, drawerOffset: null });
      return;
    }
    if (get().drawerOpen) {
      // 已经开着（比如拖动中又调了一次）：不要重播入场
      return;
    }
    const width = get().drawerWidth || 320;
    const seq = get().drawerEnterSeq + 1;
    set({ drawerOpen: true, drawerOffset: -width, drawerEnterSeq: seq });
    // 双 rAF：第一帧让浏览器真正把"停在屏幕外"渲染出来，第二帧再改目标值，过渡才有起点。
    // 合成一次更新的话过渡不会触发，抽屉会"啪"地直接出现。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const st = get();
        if (st.drawerEnterSeq !== seq || !st.drawerOpen || st.drawerOffset !== -width) return;
        set({ drawerOffset: 0 });
        setTimeout(() => {
          const after = get();
          if (after.drawerEnterSeq === seq && after.drawerOpen && after.drawerOffset === 0) {
            set({ drawerOffset: null });
          }
        }, DRAWER_SETTLE_MS);
      });
    });
  },

  setDrawerOffset(offset, dragging = true) {
    // 拖动/吸附一律作废尚未落地的入场动画（见 setDrawer 里那段注释）
    void dragging;
    set({ drawerOffset: offset, drawerEnterSeq: get().drawerEnterSeq + 1 });
  },

  setDrawerWidth(width) {
    // 只在真的变了才写：拖动中每帧都设会白白触发重渲染（留 1px 容差）
    if (width > 0 && Math.abs(width - get().drawerWidth) > 1) set({ drawerWidth: width });
  },

  settleDrawer(release) {
    const { drawerOffset, drawerWidth, setDrawerOffset } = get();
    if (drawerOffset === null) return;
    // 先看甩动速度（轻轻一甩就按方向定），没有速度才退回"过半"的位置判定
    const open = shouldSnapOpen(
      drawerOffset,
      drawerWidth,
      release?.velocity ?? 0,
      release?.travelled ?? 0,
    );
    const target = open ? 0 : -drawerWidth;
    setDrawerOffset(target, false); // 松手后开过渡，滑到落点
    setTimeout(() => {
      // 动画期间用户又动了（偏移已不是那个落点）就不要覆盖他的状态
      if (get().drawerOffset !== target) return;
      set({ drawerOffset: null, drawerOpen: open });
    }, DRAWER_SETTLE_MS);
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
