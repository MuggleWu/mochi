/**
 * 应用状态（zustand）。
 *
 * 性能纪律：列表与搜索**只读内存里的清单**；只有打开/保存某篇才碰文件。
 */
import { create } from 'zustand';
import type { FileStore } from '@core/fs/store';
import { MANIFEST_FILE } from '@core/fs/layout';
import { NotesRepo } from '@core/repo/notes-repo';
import {
  emptyMeta,
  deserializeMeta,
  serializeMeta,
  pendingContentCount,
  type Meta,
  type NoteEntry,
} from '@core/sync/manifest';
import { L1_COUNT, planDownloads, runDownloads } from '@core/sync/pull-content';
import { FLAG } from '@core/sync/manifest';
import { GithubClient, type FetchLike } from '@core/net/github';
import { fetchSnapshot, reconcileSnapshot } from '@core/sync/pull-metadata';
import { DEFAULT_SETTINGS, type Settings, isConfigured, loadSettings, saveSettings } from '@core/sync/settings';
import { shouldSnapOpen } from './edge-swipe';
import { DRAWER_SETTLE_MS } from './drawer-anim';
import { search, type SearchIndex } from '@core/search/index';
import { loadIndex, saveIndex, indexNotes, indexOne, type IndexNote } from '@core/search/store';
import { mergeRows, snippetFor, type SearchRow } from './search-view';

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

  /** 内容拉取中的阶段文案（空串 = 没在拉）。 */
  pullStage: string;
  /** 本次内容拉取已完成篇数。 */
  pullDone: number;
  /** 本次内容拉取计划总篇数。 */
  pullTotal: number;
  /** 还差多少篇内容没下载（全部，不只是本次计划）。 */
  pendingContent: number;
  /** 内容拉取是否暂停。 */
  pullPaused: boolean;
  /** 正在单独拉取某一篇（L3 按需）。 */
  openingNote: boolean;

  /** 当前搜索框里输入的内容。 */
  query: string;
  /** 搜索结果行（文件名命中在前，正文命中在后）。空查询时为空数组，列表退回全量 order。 */
  rows: SearchRow[];
  /** 全文索引里已收录的篇数，用于告诉用户"索引还在建"。 */
  indexed: number;
  /** 索引是否还在后台建（true 时正文搜索可能不全）。 */
  indexing: boolean;

  init(store: FileStore): Promise<void>;
  saveConfig(next: Settings): Promise<void>;
  /** 拉取远端元数据（阶段一）：一个请求拿到全部笔记，不下载内容。 */
  pullMetadata(): Promise<void>;
  /** 拉取内容：先 L1（最近 300 篇），再 L2（后台补齐）。自动开跑，可暂停。 */
  pullContent(options?: { limit?: number }): Promise<void>;
  /** 暂停内容拉取（当前批次跑完即停，已下好的保留）。 */
  pauseContent(): void;
  /** 单篇内容到位后并入清单（下载与按需拉取共用）。 */
  setNoteEntry(entry: NoteEntry): void;
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
  setScrollRatio(r: number): void;
  dismissError(): void;
  /** 主动报一个错（内链找不到目标、按需拉取失败等）。 */
  setError(message: string | null): void;
  /**
   * 抽屉列表当前要渲染的路径。
   *
   * 空查询 → 全量（按修改时间倒序）；有查询 → 搜索结果（文件名命中在前，正文命中在后）。
   */
  visible(): string[];
  /**
   * 搜索框内容变化。
   *
   * 文件名结果是**同步**出的（只查内存清单，零 IO），所以输入时立刻有反馈；
   * 正文结果要读本地文件拿摘要，异步补上。
   */
  setSearchQuery(q: string): Promise<void>;
  /** 把本地已下载的笔记灌进索引（冷启动后调用一次，后台跑）。 */
  buildSearchIndex(): Promise<void>;
}

let store: FileStore | null = null;
let repo: NotesRepo | null = null;
/** 网络实现可注入，便于端到端自测（默认走真实 fetch）。 */
let fetchImpl: FetchLike | undefined;

/** 全文索引。放模块级而不是 state：它是几十 MB 的大对象，不该进渲染快照。 */
let searchIndex: SearchIndex | null = null;
/**
 * 索引的改动计数：每次改动 +1。落盘后记下"写的是哪一版"。
 *
 * 为什么不用布尔值：落盘是异步的，写盘期间完全可能又改了一篇；用布尔值就没法区分
 * "我写的就是最新版"和"我写的是旧版、期间又变了"，会把未落盘的改动误标成已保存。
 */
let indexVersion = 0;
/** 已落盘的版本号。 */
let indexSavedVersion = 0;
/** 正在跑的那次"全量建索引"。并发触发时直接复用，不叠第二份。 */
let indexRun: Promise<void> | null = null;
/** 搜索的世代号：输入变化很快时，旧的异步结果不该覆盖新的。 */
let searchGeneration = 0;
/** 搜索结果条数上限。够用了：再多用户也不会滚到底，而且每多一条就多一次读盘拿摘要。 */
const SEARCH_LIMIT = 100;

/**
 * 把索引落盘（有改动才写）。
 *
 * 单独抽出来给"低频但必须立刻持久化"的操作用（保存、改名、删除）：
 * 这些操作之后如果进程被杀，索引里留着旧内容会搜出错的东西 —— 那比"搜索不全"更糟。
 * 批量下载那条路径不用它（按批落盘即可，中断了重下就是）。
 */
async function flushIndex(): Promise<void> {
  if (indexVersion === indexSavedVersion || !searchIndex || !store) return;
  const snapshotStore = store;
  const writing = indexVersion; // 记下"我正在写哪一版"
  await saveIndex(snapshotStore, searchIndex);
  // 写盘期间又改了，就不能把新改动标记成已保存
  if (indexVersion === writing) indexSavedVersion = writing;
}
/** 内容拉取是否被要求暂停。放模块级：循环里每次都要读，且暂停必须在当前批次后立刻生效。 */
let pullStopRequested = false;
/**
 * 正在跑的那次内容拉取。放模块级而不是 state：Promise 不该进渲染状态，
 * 但"等它跑完"是外部（端到端自测、同步收尾）真实需要的，所以留一个可等待的句柄。
 */
let pullRun: Promise<void> | null = null;
/**
 * 世代号：每次开始新的内容拉取就 +1。旧的那次在下一批任务前会看到自己的世代号过期而退出 ——
 * 端到端自测里换了假网络时，上一次的运行必须立刻让位，否则会拿新网络去下旧任务。
 */
let pullGeneration = 0;

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
  rows: [],
  indexed: 0,
  indexing: false,
  scrollRatio: 0,
  error: null,
  toast: null,
  settings: { ...DEFAULT_SETTINGS },
  syncStage: '',
  lastSyncNote: '',
  pullStage: '',
  pullDone: 0,
  pullTotal: 0,
  pendingContent: 0,
  pullPaused: false,
  openingNote: false,

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

    // 索引：先同步读盘（几 MB，几十毫秒，这部分等得起），建索引则丢到后台。
    // 为什么不在启动路径里建：一万篇实测十几秒，绝不能卡住"打开就能读"。
    const loaded = await loadIndex(fs);
    searchIndex = loaded.index;
    set({ indexed: searchIndex.docIdOf.size });

    if (!loaded.loaded) {
      // 没有可用的索引文件 → 后台重建。期间按文件名搜索照常可用。
      void get().buildSearchIndex();
    } else {
      // 索引里收录的篇数 < "本地真有内容的篇数" 才需要补。
      // 注意不能拿"笔记总数"比：绝大多数笔记只有元数据（没下载内容），
      // 拿总数比会导致每次启动都触发一次全量重建。
      const withContent = Object.values(meta.notes).filter((e) => e.localSha !== '').length;
      if (searchIndex.indexedSha.size < withContent) void get().buildSearchIndex();
    }

    // 已经配置过就直接同步一次（用户要的"打开即自动拉"）。
    // 远端没动时 ETag 短路只要 0.8 秒，代价很小；没配置就什么都不做。
    if (isConfigured(settings)) void get().pullMetadata();
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
      const pending = pendingContentCount(next);
      set({
        meta: next,
        order,
        syncStage: '',
        lastSyncNote: `已读取 ${snap.files.length} 篇笔记的清单，待下载内容 ${pending} 篇`,
        toast: `远端共 ${snap.files.length} 篇笔记`,
        pendingContent: pending,
      });
      await persistManifest(next);
      // 清单就位后**不 await**：列表此刻已经可用，内容下载是后台的事。
      // 让它接着跑，用户马上就能打开最近的笔记（D4 的"能立刻用"）。
      if (pending > 0) void get().pullContent();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({ syncStage: '', error: hint ? `${message}\n${hint}` : message });
    }
  },

  async pullContent(options) {
    const run = doPullContent(options);
    pullRun = run;
    await run;
  },

  pauseContent() {
    // 只置标记：runDownloads 会在当前批次跑完后自然退出，已下好的保留
    pullStopRequested = true;
    set({ pullPaused: true });
  },

  setNoteEntry(entry) {
    const meta = get().meta;
    const next: Meta = { ...meta, notes: { ...meta.notes, [entry.path]: entry } };
    set({ meta: next, pendingContent: pendingContentCount(next) });
  },

  async createNote() {
    if (!repo) return;
    const { meta } = get();
    const entry = await repo.create(meta, '');
    const next = { ...meta, notes: { ...meta.notes, [entry.path]: entry } };
    if (searchIndex) {
      indexOne(searchIndex, { path: entry.path, content: '', sha: entry.localSha, hasContent: true });
      indexVersion += 1;
    }
    set({ meta: next, order: Object.keys(next.notes).sort(byMtimeDesc(next)), current: entry.path, content: '', mode: 'edit', dirty: true });
    await persistManifest(next);
  },

  async openNote(path: string) {
    if (!repo) return;
    const opened = await repo.open(path);
    if (opened) {
      set({
        current: path,
        content: opened.content,
        mode: 'read',
        dirty: false,
        drawerOpen: false,
        drawerOffset: null,
        scrollRatio: 0,
      });
      return;
    }

    // 本地没有内容 → L3 按需拉取：打开哪篇拉哪篇。
    // 这是"首启只有最近 300 篇可读"的兜底 —— 用户点了一篇很久没动的笔记时，
    // 不该只得到一句"尚未下载"，有网就顺手拉下来。
    const { settings, meta } = get();
    const entry = meta.notes[path];
    if (!isConfigured(settings) || !entry?.remoteSha) {
      set({ error: `《${path}》尚未下载，且没有可用的同步配置。` });
      return;
    }

    set({ openingNote: true, error: null });
    try {
      const client = new GithubClient({
        token: settings.token,
        repo: settings.repo,
        branch: settings.branch,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      const text = await client.readBlobText(entry.remoteSha);
      const saved = await repo.acceptRemote(path, text, entry.remoteSha);
      if (!saved) {
        set({ openingNote: false, error: `《${path}》下载内容校验不符，暂时打不开。` });
        return;
      }
      get().setNoteEntry(saved);
      await persistManifest(get().meta);
      if (searchIndex) {
        indexOne(searchIndex, { path, content: text, sha: saved.localSha, hasContent: true });
        indexVersion += 1;
      }
      set({
        current: path,
        content: text,
        mode: 'read',
        dirty: false,
        drawerOpen: false,
        drawerOffset: null,
        scrollRatio: 0,
        openingNote: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({
        openingNote: false,
        // 无网时如实说"尚未下载"，不假装成别的问题
        error: hint ? `${message}\n${hint}` : `${message}（《${path}》尚未下载，联网后可打开）`,
      });
    }
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
    if (searchIndex) {
      indexOne(searchIndex, { path: current, content, sha: merged.localSha, hasContent: true });
      indexVersion += 1;
      void flushIndex(); // 编辑是低频操作，可以立刻落盘
    }
    set({
      meta: next,
      order: Object.keys(next.notes).sort(byMtimeDesc(next)),
      dirty: false,
      toast: '已保存',
      indexed: searchIndex?.indexedSha.size ?? 0,
    });
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
  setScrollRatio(scrollRatio) {
    set({ scrollRatio });
  },
  dismissError() {
    set({ error: null });
  },
  setError(message) {
    set({ error: message });
  },

  async setSearchQuery(query) {
    set({ query });
    const q = query.trim();
    if (!q) {
      set({ rows: [] });
      return;
    }
    const generation = ++searchGeneration;
    const nameHits = get()
      .order.filter((p) => p.toLowerCase().includes(q.toLowerCase()))
      .slice(0, SEARCH_LIMIT);

    // 先只出文件名结果：这一步零 IO，敲字就有反馈
    set({ rows: nameHits.map((path) => ({ path, kind: 'name' as const })) });

    const { meta } = get();
    const contentHits = searchIndex
      ? search(searchIndex, q, {
          mtimeOf: (path) => meta.notes[path]?.mtime ?? 0,
          limit: SEARCH_LIMIT,
        }).map((hit) => hit.path)
      : [];

    const content = contentHits.filter((p) => !nameHits.includes(p));
    if (content.length === 0) return;

    // 读命中笔记的正文来生成摘要。只读命中的那些（最多 SEARCH_LIMIT 篇），
    // 不做全库扫描 —— 这正是"搜索零读盘"的边界：排序零读盘，展示摘要要读命中的几篇。
    const snippets = new Map<string, { snippet: string; hl?: [number, number] }>();
    if (repo) {
      const want = new Set(content.slice(0, SEARCH_LIMIT));
      await Promise.all(
        [...want].map(async (path) => {
          const text = await repo!.readTextIfPresent(path);
          if (text !== null) snippets.set(path, snippetFor(text, q.split(/\s+/)[0] ?? q));
        }),
      );
    }
    if (generation !== searchGeneration) return; // 用户又敲了字，这批结果已经过期

    set({
      rows: mergeRows(
        nameHits,
        content,
        (path) => snippets.get(path) ?? { snippet: '' },
        SEARCH_LIMIT,
      ),
    });
  },

  async buildSearchIndex() {
    if (!store) return;
    if (indexRun) return indexRun; // 已经在建，别叠第二份
    const run = (async (): Promise<void> => {
      const started = Date.now();
      if (!searchIndex) searchIndex = (await loadIndex(store!)).index;
      const index = searchIndex;
      const { meta, order } = get();
      set({ indexing: true, indexed: index.docIdOf.size });

      // 已下载内容的笔记才建索引。只有元数据的没有正文可索引。
      const batch: IndexNote[] = [];
      for (const path of order) {
        const entry = meta.notes[path];
        if (!entry || entry.localSha === '') continue;
        const text = await repo?.readTextIfPresent(path);
        if (text === null || text === undefined) continue;
        batch.push({ path, content: text, sha: entry.localSha, hasContent: true });
      }

      if (batch.length > 0) {
        indexNotes(index, batch);
        indexVersion += 1;
        await saveIndex(store!, index);
        indexSavedVersion = indexVersion;
      }
      set({
        indexing: false,
        indexed: index.docIdOf.size,
        lastSyncNote: get().lastSyncNote,
      });
      void started;
    })();
    indexRun = run;
    try {
      await run;
    } finally {
      indexRun = null;
    }
  },

  visible() {
    const { order, query, rows } = get();
    if (!query.trim()) return order;
    return rows.map((r) => r.path);
  },
}));

/**
 * 内容拉取的实际实现（从 store 的 action 里抽出来）。
 *
 * 抽出来的理由：要能"等它跑完"与"作废它"。action 里的 `void get().pullContent()`
 * 是后台跑的，外部拿不到句柄；而端到端自测换了假网络时，上一次的运行必须立刻让位。
 */
async function doPullContent(options?: { limit?: number }): Promise<void> {
  const generation = ++pullGeneration;
  const stale = (): boolean => generation !== pullGeneration;
  const get = (): NotesState => useNotes.getState();
  const set = (patch: Partial<NotesState>): void => useNotes.setState(patch);
  const state = get();
  if (!isConfigured(state.settings) || !repo) return;
  if (state.pullStage) return; // 已经在拉，不要叠第二份

  const limit = options?.limit;
  // 新一代开始就把上一代的暂停标记清掉：否则用户"暂停后再继续"会被旧标记立刻停住
  pullStopRequested = false;
  set({ pullPaused: false });

  const client = new GithubClient({
    token: state.settings.token,
    repo: state.settings.repo,
    branch: state.settings.branch,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  // 本次运行里失败的篇目：不要在同一次运行里反复重试（下一轮同步自然会再试一遍）
  const failed = new Set<string>();
  let totalOk = 0;
  let totalFailed = 0;

  try {
    // 循环两轮：第一轮 L1（最近 300 篇，先让"打开就能读"），第二轮 L2（后台补齐其余）。
    // 每轮都重新算 plan —— localSha 在 acceptRemote 后已经更新，所以已下好的会自然被排除，
    // 不需要额外的"下到哪了"游标（那种状态一旦和清单不一致就会漏下或重下）。
    for (const tier of ['L1', 'L2'] as const) {
      // 每一批任务前检查：用户暂停了，或者这次运行已经被新一代取代
      if (pullStopRequested || stale()) break;
      const meta = get().meta;
      const plan = planDownloads({
        order: get().order,
        notes: meta.notes,
        skip: failed,
        ...(tier === 'L1' ? { limit: limit ?? L1_COUNT } : {}),
      });
      if (plan.paths.length === 0) continue;

      set({
        pullStage: tier === 'L1' ? '下载最近笔记' : '后台补齐内容',
        pullDone: 0,
        pullTotal: plan.paths.length,
      });

      const result = await runDownloads({
        paths: plan.paths,
        fetchText: (sha) => client.readBlobText(sha),
        remoteShaOf: (path) => get().meta.notes[path]?.remoteSha,
        accept: async (path, content, remoteSha) => {
          const entry = await repo!.acceptRemote(path, content, remoteSha);
          if (!entry) return false;
          get().setNoteEntry(entry);
          // 内容一落地就进索引：用户下完就能搜到，不必等整轮结束
          if (searchIndex) {
            indexOne(searchIndex, { path, content, sha: entry.localSha, hasContent: true });
            indexVersion += 1;
          }
          return true;
        },
        onProgress: (p) => {
          set({ pullDone: p.done });
        },
        shouldStop: () => pullStopRequested || stale(),
      });

      for (const path of result.failed) failed.add(path);
      totalOk += result.ok.length;
      totalFailed += result.failed.length;
      // 每轮结束落一次盘即可：逐篇写会伤闪存，且真中断了也只是重下
      await persistManifest(get().meta);
      if (result.stopped) break;
    }

    if (stale()) return; // 已被新一代取代，别把它的状态覆盖掉
    // 索引按批落盘：逐篇写会伤闪存，而真中断了也只是重建一次
    await flushIndex();
    const pending = pendingContentCount(get().meta);
    const stopped = pullStopRequested;
    set({
      pullStage: '',
      pendingContent: pending,
      pullPaused: stopped && pending > 0,
      lastSyncNote: stopped
        ? `已暂停：本次下好 ${totalOk} 篇，还差 ${pending} 篇`
        : `内容已就绪：本次下好 ${totalOk} 篇${totalFailed ? `，${totalFailed} 篇失败` : ''}，还差 ${pending} 篇`,
      ...(totalOk > 0 && !stopped ? { toast: `已下载 ${totalOk} 篇笔记内容` } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    set({
      pullStage: '',
      pendingContent: pendingContentCount(get().meta),
      error: hint ? `${message}\n${hint}` : message,
    });
  }
}

/** 清单落盘（只写这一个文件；内容搜索索引是 M4 的事）。 */
async function persistManifest(meta: Meta): Promise<void> {
  if (!store) return;
  await store.writeText(MANIFEST_FILE, serializeMeta(meta));
}

/** 供端到端自测注入假网络（不传则走真实 fetch）。 */
export function __setFetchForTest(fake?: FetchLike): void {
  fetchImpl = fake;
}

/**
 * 等正在跑的内容拉取结束（端到端自测用）。
 *
 * 为什么必须有：`pullMetadata()` 里那一句 `void get().pullContent()` 是后台跑的，
 * 调用方 await 不到它。测试如果不先等它结束，就会带着悬空异步进入下一个用例 ——
 * 表现为"上一个用例的请求数跑到了下一个用例里"。
 */
export async function __awaitContentPullForTest(): Promise<void> {
  while (pullRun) {
    const run = pullRun;
    await run.catch(() => {});
    if (pullRun === run) pullRun = null;
  }
}

/** 作废正在跑的内容拉取（换假网络前调用，别让它拿新网络去下旧任务）。 */
export function __abortContentPullForTest(): void {
  pullGeneration++;
  pullStopRequested = true;
  pullRun = null;
}

/** 供端到端自测注入替身文件层（浏览器里没有 Capacitor 桥时也走它）。 */
export function __setFileStoreForTest(fs: FileStore): void {
  store = fs;
  repo = new NotesRepo(fs);
}
