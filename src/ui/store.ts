/**
 * 应用状态（zustand）。
 *
 * 性能纪律：列表与搜索**只读内存里的清单**；只有打开/保存某篇才碰文件。
 */
import { create } from 'zustand';
import type { FileStore } from '@core/fs/store';
import { MANIFEST_FILE, SESSION_FILE } from '@core/fs/layout';
import { NotesRepo } from '@core/repo/notes-repo';
import {
  emptyMeta,
  deserializeMeta,
  serializeMeta,
  pendingContentCount,
  dirtyCount,
  diffWithRemote,
  markPushed,
  type Meta,
  type NoteEntry,
  type RemoteNote,
} from '@core/sync/manifest';
import { CONCURRENCY, L1_COUNT, planDownloads, runDownloads } from '@core/sync/pull-content';
// 与内容下载用同一个并发数。整理历史是"每提交一个请求"，单路要几十分钟；
// 并发起来能把总时间压到分钟级，再高容易撞限流。
const HISTORY_CONCURRENCY = CONCURRENCY;

/**
 * 单次同步最多整理多少个提交。
 *
 * 从最新往旧走，走满就停，前沿记下，下次接着走。取这个数是为了"第一次同步就能看到
 * 正确排序"：近期改动集中在最新的一段里，先把这一段算准，用户马上能感受到效果，
 * 历史深处则在后续每次同步里慢慢补齐（每次的成本是可控的、且随时可中断）。
 */
const HISTORY_WINDOW = 300;

/**
 * 一次同步里最多连续整理几段历史。
 *
 * 为什么需要连续走：一次只走一段的话，**要等下一次同步才继续**，而用户可能几小时才
 * 同步一次 —— 期间列表里大片笔记停在"时间未知"，而未知的那些是按"下载时刻"排的，
 * 等于乱序。这就成了用户看到的"排序不太好"。
 *
 * 那为什么不干脆把 `HISTORY_WINDOW` 设成很大一次走完：单段太大会让**第一屏的顺序**
 * 迟迟不出现（要从最新的往后走很多才轮到近期那批）。分段循环两头都顾上：每段结束都
 * 落一次盘、刷一次列表，用户很快看到近期排序，之后后台继续把剩下的补齐。
 *
 * 上限存在的意义只是"别把一次同步拖太久"，剩下的下次同步接着走（前沿已记下）。
 */
const HISTORY_MAX_PASSES = 8;
import { FLAG, hasRealMtime } from '@core/sync/manifest';
import { clipboardText, writeClipboardText } from '@core/clipboard';
import { pushMessage, pushNotes, pathsToPush } from '@core/sync/push';
import { conflictsOf, withConflicts, type ConflictItem } from '@core/sync/conflict';
import { deserializeSession, serializeSession, type SessionState } from '@core/fs/session';
import { displayTitle } from '@core/paths';
import { GithubClient, humanizeWait, type FetchLike } from '@core/net/github';
import { fetchSnapshot, reconcileSnapshot } from '@core/sync/pull-metadata';
import { walkHistory } from '@core/history/mtime';
import { DEFAULT_SETTINGS, type Settings, isConfigured, loadSettings, saveSettings } from '@core/sync/settings';
import { shouldSnapOpen } from './edge-swipe';
import { DRAWER_SETTLE_MS } from './drawer-anim';
import { search, type SearchIndex } from '@core/search/index';
import { loadIndex, saveIndex, indexNotes, indexOne, type IndexNote } from '@core/search/store';
import { updateNote } from '@core/search/index';
import { auditIndexAgainstText } from '@core/search/audit';
import { mergeRows, snippetFor, type SearchRow } from './search-view';
import { textHasQuery } from '@core/search/verify';

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
  /**
   * 改名弹窗 / 同步弹层 / 查找栏是否开着。
   *
   * 这三个原本是组件内的 useState，提到 store 只为一个原因：**Android 返回键**。
   * 返回键的处理要按"最上面那层先关"的顺序来（见 `back-stack.ts`），而处理函数
   * 在 App 顶层，看不到子组件的局部状态。状态放这里，优先级才有一处可判。
   */
  ui: { rename: boolean; sync: boolean; find: boolean; menu: boolean; selfCheck: boolean };
  error: string | null;
  toast: string | null;
  /** 同步配置（仓库/分支/令牌）。令牌只在内存与私有文件里。 */
  settings: Settings;
  /** 同步进行中的阶段文案（空串 = 空闲）。 */
  syncStage: string;
  /**
   * 推送进行中的阶段文案（空串 = 空闲）。
   *
   * 与 `syncStage` 分开：两者可能同时在跑（"同步"里先拉后推），共用一个字段会互相覆盖，
   * 用户看到的阶段就会跳来跳去。
   */
  pushStage: string;
  /**
   * 待推送的篇数（界面据此提醒）。
   *
   * 只由"真的算过一次推送集合"的地方更新 —— 不在启动时猜。要算准它必须重建清单
   * （读一遍本地笔记），启动时不该干这个。
   */
  pushDirty: number;
  /** 待决冲突（手机和电脑都改过同一篇），界面据此提示用户定哪边为准。 */
  conflicts: ConflictItem[];
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
  /**
   * 额度恢复、自动续下的时刻（毫秒时间戳；0 = 没有排着自动续下）。
   *
   * 给界面用：显示"X 后自动接着下"，也让"回到前台时补一次检查"有依据。
   */
  pullResumeAt: number;
  /** 正在单独拉取某一篇（L3 按需）。 */
  openingNote: boolean;
  /** 整理版本历史的进度：已完成段数 / 总段数（0/0 = 没在整理）。 */
  histDone: number;
  histTotal: number;
  /**
   * 历史整理的结果说明。
   *
   * **必须与 `lastSyncNote` 分开**：内容下载和历史整理是两个互不等待的后台任务，
   * 共用一个字段就会互相覆盖（先跑完的被后跑完的盖掉，界面显示的取决于谁慢）。
   */
  histNote: string;

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
  /**
   * 让清单与远端一致。
   *
   * `deferContent` 为真时不自动开始下载正文 —— 留给调用方在合适时机再放它跑
   * （同步入口要先把版本历史整理完，见 `syncNow`）。
   */
  pullMetadata(opts?: { deferContent?: boolean }): Promise<void>;
  /** 拉取内容：先 L1（最近 300 篇），再 L2（后台补齐）。自动开跑，可暂停。 */
  pullContent(options?: { limit?: number }): Promise<void>;
  refreshMtimes(opts?: { maxCommits?: number }): Promise<void>;
  syncNow(): Promise<void>;
  /** 暂停内容拉取（当前批次跑完即停，已下好的保留）。 */
  pauseContent(): void;
  /**
   * 补一次"到点该接着下了吗"的检查。
   *
   * 定时器只是**主路**：Android 会把后台的 WebView 挂起，挂起期间定时器不走，
   * 回到前台时可能早就过了恢复时刻。所以前台恢复时调一次这里兜底 ——
   * 两条路谁都行，先到的那条负责续上。
   */
  resumePullIfDue(): void;
  /** 单篇内容到位后并入清单（下载与按需拉取共用）。 */
  setNoteEntry(entry: NoteEntry): void;
  createNote(): Promise<void>;
  openNote(path: string): Promise<void>;
  /**
   * 按列表顺序打开上一篇 / 下一篇。
   *
   * 顺序就是列表本身的顺序（最近改的在前），所以「下一篇」= 列表里往更早的方向走，
   * 与用户在列表里往下滚的直觉一致。到头或没开笔记时什么也不做。
   */
  openNeighbor(direction: -1 | 1): Promise<void>;
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
  /** 开/关某个界面层（返回键与界面按钮共用同一处状态）。 */
  setUi(key: 'rename' | 'sync' | 'find' | 'menu' | 'selfCheck', open: boolean): void;
  /**
   * 把当前笔记复制到系统剪贴板，供用户贴到别的应用里发给别人。
   *
   * `withTitle` 默认 true：贴出去时没有标题的正文常常读不懂。
   */
  copyCurrentNote(options?: { withTitle?: boolean }): Promise<void>;
  /**
   * 把"离开时的样子"写进磁盘，供下次打开时还原。
   *
   * 落盘时机由调用方决定（App 在切后台/退到后台时调），见 `session-state.ts` 的说明。
   */
  saveSession(): Promise<void>;
  /**
   * 推送本地改动到仓库。
   *
   * **先拉一次再推**：`lastCommit` 是"我们已知的远端状态"，推送要基于它建新提交。
   * 不先拉的话，别处（电脑上的 Obsidian）刚推过就会撞上非快进，白白失败一次。
   * 拉取本身在有 ETag 时几乎不花流量。
   *
   * 没有改动时什么都不做 —— 空提交只会污染历史。
   */
  pushNow(): Promise<void>;
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

/**
 * 拿当前的文件夹层（诊断页要读一次目录）。
 *
 * 为什么用取值函数而不是把 store 放进 state：它是个**生命周期对象**，不是界面数据 ——
 * 放进 state 的话，测试里 `setState` 重置界面状态时会把它一起清掉，表现为"诊断页
 * 在测试里读不到文件"。取值函数没有这个问题，也不会让 store 进到任何渲染依赖里。
 */
export function getStore(): FileStore | null {
  return store;
}
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

/**
 * 搜索词的落盘防抖句柄。
 *
 * 每敲一个字就写一次会话文件太浪费（一次 IO 换一个字符，输入法联想下尤其密），
 * 所以攒一小会儿再写。但这带来一个必须处理的坑：**会话文件里还有草稿等状态**，
 * 若防抖回调晚于 `saveSession()` 落地，就会拿旧的 query 把新写的会话覆盖回去 ——
 * 因此 `saveSession()` 里要先把它取消掉。
 */
let querySaveTimer: ReturnType<typeof setTimeout> | null = null;
const QUERY_SAVE_DELAY_MS = 400;
/** 搜索结果条数上限。够用了：再多用户也不会滚到底，而且每多一条就多一次读盘拿摘要。 */
const SEARCH_LIMIT = 100;

/** 取消尚未落地的搜索词写入。 */
function cancelQuerySave(): void {
  if (querySaveTimer !== null) {
    clearTimeout(querySaveTimer);
    querySaveTimer = null;
  }
}

/**
 * 把搜索词攒一小会儿再落盘。
 *
 * 搜索词属于"下次打开还想看到"的状态，但它**只在会话文件里持久化** —— 而会话只在
 * 切后台、切模式那类时机才写。于是"敲完词直接杀掉应用"这一路，关键词就丢了
 * （真机反馈：重开应用，之前搜的词和结果都没了）。
 *
 * 这里不立刻写、而是延后一小会儿，是因为每敲一个字写一次太浪费；而
 * `saveSession()` 会先 `cancelQuerySave()`，所以两条写入路径不会互相覆盖。
 */
function scheduleQuerySave(): void {
  cancelQuerySave();
  querySaveTimer = setTimeout(() => {
    querySaveTimer = null;
    void useNotes.getState().saveSession();
  }, QUERY_SAVE_DELAY_MS);
}

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
 * "到点自动接着下"的定时器。
 *
 * 额度是按小时窗口算的，用完之后只能等。等的过程没必要让用户盯着、到点再手动点一下 ——
 * 所以这里排一个定时器自动续上。
 *
 * `pullResumeGen` 是它的世代号：用户按暂停、或新一次拉取开始，都要把在途的这次续期
 * **作废**。否则会出现"用户明明按了暂停，几分钟后它自己又跑起来"。
 */
let pullResumeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 下一次 `setTimeout` 调用是否属于"自动续下"。
 *
 * 为什么需要这个标志：测试要抓住**这一个**定时器，而按"时长"去认是靠不住的 ——
 * 重试退避也会排到一分钟，跟额度等待的区间重叠。在调用点插一个标志，识别就与时长无关，
 * 将来等多久都不会失效。
 */
export let __nextTimeoutIsAutoResume = false;
let pullResumeGen = 0;
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

/** 正在跑的历史整理（后台起，测试要能等它结束）。 */
let histRun: Promise<void> | null = null;

/** 起一次历史整理并记下句柄；已经在跑就不重复起。 */
/**
 * 取消已排的"自动续下"。
 *
 * 每次取消都让世代号 +1：即使定时器已经进入回调、正在等调度，它醒来时也会发现自己过期了。
 * 只 `clearTimeout` 是不够的 —— 回调可能已经在队列里。
 */
function cancelAutoResume(): void {
  pullResumeGen += 1;
  if (pullResumeTimer !== null) {
    clearTimeout(pullResumeTimer);
    pullResumeTimer = null;
  }
}

/**
 * 排一次"到点自动接着下"。
 *
 * 两个真机上的坑要处理：
 * 1. **后台定时器会被冻结**：Android 把 WebView 挂起后定时器不走，回到前台时可能早就过了
 *    恢复时刻。所以这里既排定时器，也让 `App` 在回到前台时调 `resumeIfDue()` 补一次检查 ——
 *    两条路都能续上，谁先到算谁。
 * 2. **重置时刻可能已经过去**（例如离得很近、或刚被冻结过）：那就直接续，不要白等一个负的时长。
 */
function scheduleAutoResume(at: number): void {
  cancelAutoResume();
  const gen = pullResumeGen;
  const wait = Math.max(0, at - Date.now());
  // 夹到定时器的 32 位上限：额度窗口最多一小时、远在其内，但时刻被传得很远时不该溢出
  const capped = Math.min(wait, 2 ** 31 - 1);
  __nextTimeoutIsAutoResume = true;
  pullResumeTimer = setTimeout(() => {
    pullResumeTimer = null;
    if (gen !== pullResumeGen) return; // 已被取消（用户暂停 / 新一次拉取）
    const st = useNotes.getState();
    if (st.pullStage) return; // 已经在拉，别叠第二份
    if (pendingContentCount(st.meta) === 0) {
      useNotes.setState({ pullResumeAt: 0 });
      return;
    }
    useNotes.setState({ pullResumeAt: 0 });
    void useNotes.getState().pullContent();
  }, capped);
  __nextTimeoutIsAutoResume = false;
}

function startRefreshMtimes(opts?: { maxCommits?: number }): Promise<void> {
  if (histRun) return histRun; // 已经在整理，复用同一份，不叠第二次
  const run = useNotes.getState().refreshMtimes(opts);
  histRun = run;
  void run.finally(() => {
    if (histRun === run) histRun = null;
  });
  return run;
}

/**
 * 列表顺序：**时间已知的按真实时间倒序在前，时间未知的整组在后**。
 *
 * 分区比较，不做跨组减法 —— 真实时间与"落盘时刻"不是同一个量纲，混着比会把老笔记
 * 顶到最上面。为什么这一点非如此不可：落盘时间是"刚刚"，而真实时间可能是两年前；
 * 若让未知的参与正常比较，所有还没反推出时间的老笔记会一起顶到最上面，恰好和"近期
 * 修改的排在前面"这个目标相反。宁可承认"不知道"，也不要给出方向错误的顺序。
 *
 * 抽屉列表、搜索结果共用这一套（搜索只是它的一个子序列）。
 */
const byMtimeDesc =
  (meta: Meta) =>
  (a: string, b: string): number => {
    const ka = hasRealMtime(meta.notes[a]);
    const kb = hasRealMtime(meta.notes[b]);
    if (ka !== kb) return ka ? -1 : 1; // 已知的排前面
    const va = ka ? (meta.notes[a]?.fileMtime ?? 0) : (meta.notes[a]?.mtime ?? 0);
    const vb = kb ? (meta.notes[b]?.fileMtime ?? 0) : (meta.notes[b]?.mtime ?? 0);
    return vb - va;
  };

/** 同一个顺序的数组版，供搜索把两批命中合并后统一排序。 */
const orderPaths = (paths: string[], meta: Meta): string[] => [...paths].sort(byMtimeDesc(meta));

/**
 * 清单里记的远端视图，喂给三方判定。
 *
 * 抽出来是为了让"推送前估个数"和"真正推送时"用**同一个视图** —— 两处各写一遍的话，
 * 界面显示的数量和实际推的数量迟早对不上。
 */
function remoteNotesOf(meta: Meta): RemoteNote[] {
  const out: RemoteNote[] = [];
  for (const [path, e] of Object.entries(meta.notes)) {
    if (e.remoteSha) out.push({ path, sha: e.remoteSha, size: e.size });
  }
  // 墓碑自带远端 sha，所以"远端还有这条"这件事在删除之后依然查得到。
  // 少了它，删除动作会把自己后续要用的信息一起毁掉：远端视图里没有这条，
  // 三方判定就认为"远端本来就没有"，删除什么都不做 —— 而且不报错。
  const known = new Set(out.map((r) => r.path));
  for (const t of meta.removed) {
    if (known.has(t.path)) continue;
    if (!t.remoteSha) continue; // 老清单里的墓碑没记 sha，无从判定远端，只能不动它
    out.push({ path: t.path, sha: t.remoteSha, size: 0 });
  }
  return out;
}

/**
 * 还原"离开时的样子"。
 *
 * 三条纪律：
 *
 * 1. **清单里没有的笔记一律不还原**。它可能在电脑上被删/改名了，指着一个不存在的路径
 *    只会让用户看到一篇空白，比直接停在空态更让人迷惑。清掉，当作没开过。
 * 2. **有草稿就用草稿**，不读盘 —— 那正是"还没保存的改动"，读盘等于把它抹掉。
 * 3. **任何一步失败都静默降级**（读不到文件、JSON 坏了）。还原是便利，不能让应用起不来。
 */
async function restoreSession(fs: FileStore): Promise<void> {
  const get = (): NotesState => useNotes.getState();
  const set = (patch: Partial<NotesState>): void => useNotes.setState(patch);
  let saved: SessionState;
  try {
    saved = deserializeSession(await fs.readText(SESSION_FILE));
  } catch {
    return;
  }
  if (!saved.current) {
    // 当时没开笔记：搜索词这种"下次还用得上"的照样还原，抽屉不会因此打开
    if (saved.query) set({ query: saved.query });
    return;
  }
  const st = get();
  if (!st.meta.notes[saved.current]) return;

  let content = saved.draft ?? '';
  if (saved.draft === null) {
    content = (await repo?.readTextIfPresent(saved.current)) ?? '';
  }
  set({
    current: saved.current,
    content,
    mode: saved.mode,
    dirty: saved.draft !== null, // 草稿还没落盘 → 仍然是"改过没保存"
    scrollRatio: saved.scrollRatio,
    query: saved.query,
    // 抽屉一律不还原：回来时用户要看的是**笔记**，不是盖住笔记的目录
    drawerOpen: false,
  });
}

/**
 * 把反推出来的真实修改时间并进清单。
 *
 * **只接受更新的**：一次遍历里"越新的段越先算"，所以同一路径多次出现时最大值就是
 * 它最后被改动的时刻。反过来（无条件覆盖）会在增量整理时把已经正确的旧值改小。
 */
function mergeRealMtimes(
  notes: Record<string, NoteEntry>,
  files: Record<string, number>,
): { notes: Record<string, NoteEntry>; filled: number } {
  const out = { ...notes };
  let filled = 0;
  for (const [path, t] of Object.entries(files)) {
    const e = out[path];
    // 0 = 时间没解出来，不写（宁可标"未知"，也不要一个假时间）
    if (!e || t <= 0) continue;
    if (t > e.fileMtime) {
      out[path] = { ...e, fileMtime: t };
      filled += 1;
    }
  }
  return { notes: out, filled };
}

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
  ui: { rename: false, sync: false, find: false, menu: false, selfCheck: false },
  error: null,
  toast: null,
  settings: { ...DEFAULT_SETTINGS },
  syncStage: '',
  pushStage: '',
  pushDirty: 0,
  conflicts: [],
  lastSyncNote: '',
  pullStage: '',
  pullDone: 0,
  pullTotal: 0,
  pendingContent: 0,
  pullPaused: false,
  pullResumeAt: 0,
  openingNote: false,
  histDone: 0,
  histTotal: 0,
  histNote: '',

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
    // 回到离开时的样子。放在清单之后：只有清单就绪才谈得上"这篇笔记还在不在"。
    await restoreSession(fs);

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

    /*
     * 已经配置过就自动同步一次（用户要的"打开即自动拉"）。
     *
     * **必须走 `syncNow` 而不是 `pullMetadata`**：两者差的是"版本历史整理"这一步，
     * 而整理正是**列表顺序**的依据 —— 少了它，每篇都显示"时间未知"、顺序全乱。
     *
     * 这里曾经调的是 `pullMetadata`，于是那条路只在用户手动点「同步」时才通：
     * 打开应用自动拉、但顺序永远是乱的。远端没动时 ETag 会短路成 0.8 秒，代价很小。
     */
    if (isConfigured(settings)) void get().syncNow();
  },

  async saveConfig(next) {
    if (!store) return;
    await saveSettings(store, next);
    const repoChanged = next.repo !== get().settings.repo || next.branch !== get().settings.branch;
    set({ settings: next, toast: '同步设置已保存' });
    if (repoChanged) set({ lastSyncNote: '仓库已更改，下次同步会重新建立清单' });
  },

  async pullMetadata(opts?: { deferContent?: boolean }) {
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
        const localDirty = dirtyCount(meta);
        set({
          syncStage: '',
          pushDirty: localDirty,
          lastSyncNote: '远端没有变化，无需下载',
          // 有未推送的本地改动就**明说**，别只报"已是最新"让人以为一切都同步好了
          toast: localDirty > 0 ? `远端没有变化；本地有 ${localDirty} 篇改动待推送` : '已是最新',
        });
        await persistManifest({ ...meta, lastSyncAt: Date.now() });
        return;
      }
      set({ syncStage: '并入本地清单' });
      const next = reconcileSnapshot(meta, snap);
      /*
       * 顺手认一遍冲突（手机和电脑都改过同一篇）。
       *
       * 在这里认而不是只在推送时认：冲突的后果是"这一篇怎么都推不上去、也不报错"，
       * 而那要等到用户点推送才会暴露 —— 用户可能几天后才推，期间一直以为改动好好的。
       * 拉取是每次打开都会走的路径，在这儿认出来就能马上告诉他。
       */
      const conflicts = conflictsOf(diffWithRemote(next, remoteNotesOf(next), Object.keys(next.notes)), next);
      const order = Object.keys(next.notes).sort(byMtimeDesc(next));
      const pending = pendingContentCount(next);
      set({
        meta: withConflicts(next, conflicts),
        conflicts,
        order,
        syncStage: '',
        lastSyncNote: `已读取 ${snap.files.length} 篇笔记的清单，待下载内容 ${pending} 篇`,
        toast:
          conflicts.length > 0
            ? `共有 ${conflicts.length} 篇与电脑上的改动撞车，需要你定哪边为准`
            : `远端共 ${snap.files.length} 篇笔记`,
        pendingContent: pending,
      });
      await persistManifest(get().meta);
      // 清单就位后**不 await**：列表此刻已经可用，内容下载是后台的事。
      // 让它接着跑，用户马上就能打开最近的笔记（D4 的"能立刻用"）。
      //
      // `deferContent`：从同步入口进来时先别放它跑。原因见 `syncNow` —— 它一起飞就会
      // 把额度吃光，把版本历史整理饿死，结果是"整屏时间未知"。
      if (pending > 0 && !opts?.deferContent) void get().pullContent();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({ syncStage: '', error: hint ? `${message}\n${hint}` : message });
    }
  },

  /**
   * 点一次"同步"实际做的事：读清单、下内容、核对真实修改时间。
   *
   * **为什么把这三件放在 action 里而不是全塞进 `pullMetadata`**：`pullMetadata` 的职责是
   * "让清单与远端一致"，历史整理是另一件事（失败也不影响清单可用）。分开之后，
   * 谁想知道"元数据阶段发了哪些请求"都能干净地只看 `pullMetadata`。
   */
  async syncNow() {
    await get().pullMetadata({ deferContent: true });
    if (get().error) return;

    /*
     * **顺序是刻意的：先整理时间，再下载正文。**
     *
     * 两件事都要发请求，而额度是一份。从前它们是同时起飞的，结果正文下载
     * （首启 300 篇 = 300 个请求）把额度吃光，历史整理（150 个请求）几乎必然饿死 ——
     * 表现就是整个列表全是"时间未知"，也就是"列表顺序完全是乱的"。
     *
     * 时间整理的请求量是**有上限且很小**的（每次最多走 `HISTORY_WINDOW` 个提交），
     * 而且它决定的正是用户最先看到的东西：列表顺序。所以让它先跑完这一段，
     * 再把大头的正文下载放出去 —— 两者都不阻塞界面。
     */
    await startRefreshMtimes();
    if (get().pendingContent > 0) void get().pullContent();
  },

  /**
   * 整理"真实修改时间"（从版本历史反推）。
   *
   * 幂等且增量：前沿没动时只花 1 个请求（日常同步的常态）；有新提交时按段走。
   * **失败不影响同步本身** —— 列表照旧可用，只是时间显示成"未知"。
   */
  async refreshMtimes(opts) {
    const { settings } = get();
    if (!isConfigured(settings)) return;
    if (get().histTotal > 0) return; // 已经在整理，不要叠第二份

    // 注意：这里**必须重新读一次** `meta`，不能复用进入时抓的快照。
    // 整理可能在清单同步之前就被触发（例如切后台回来的那条路径）；
    // 若拿着同步前的空清单当 `keepOnly`，历史里所有路径都会被过滤掉，
    // 结果是"跑了一整轮、一个时间都没落上"（实测踩过：界面说"没有新变化"）。
    const meta = get().meta;

    try {
      const client = new GithubClient({
        token: settings.token,
        repo: settings.repo,
        branch: settings.branch,
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      // 前沿就是最新提交 → 没事可做。提前拦一道，连"列一次提交"都省掉（日常同步的常态）。
      // `walkHistory` 内部也会判断，但那要先把提交列表拉下来才知道，白花 1 个请求。
      if (meta.histFrontier) {
        const head = await client.getRefHead();
        if (head === meta.histFrontier) return;
      }

      const current = (): Meta => get().meta;

      /*
       * **连续走若干段，直到走完整个历史**（或到本轮的段数上限）。
       *
       * 为什么要有这个循环：一次只走一段的话，剩下的要等**下一次同步**才继续，而用户
       * 可能几小时才同步一次 —— 期间列表里大片笔记停在"时间未知"。未知的那些是按
       * "下载时刻"排的，等于乱序，于是"最近改的排不到上面"，而这正是用户最先要的东西。
       *
       * 为什么不把单段设得很大一次走完：那样**第一屏的排序要等很久才出现**（要从最新的
       * 一直往后走很多才轮到近期那批）。分段循环两头兼顾：每段结束都落盘、刷列表，
       * 很快看到近期排序，之后后台继续补齐。
       */
      const fileMtimes: Record<string, number> = { ...meta.fileMtimes };
      let frontier = meta.histFrontier;
      let walkedTotal = 0;
      let more = false;
      let note = '';

      for (let p = 0; p < HISTORY_MAX_PASSES; p += 1) {
        const notesNow = current().notes;
        // 把已算出的映射喂回去：整理是**可中断**的，续传必须接着上次的结果，
        // 否则每段新建一个空映射，落盘时会把先前算好的时间全冲掉
        const res = await walkHistory({
          frontier,
          existing: fileMtimes,
          listCommits: (page) => client.listCommits(page),
          fetchChanges: async (sha) => ({ paths: await client.listCommitFiles(sha) }),
          // 历史里还留着早就删掉的文件（`.trash/` 之类），只留当前清单里有的，省清单体积
          keepOnly: new Set(Object.keys(notesNow)),
          concurrency: HISTORY_CONCURRENCY,
          onProgress: (done, total) => set({ histDone: done, histTotal: total }),
          // 每批落一次盘：中断（关应用、断网）了下次接着走，不用从头再来。
          // 存两份：原始映射（供续传）与逐条时间（供界面直接用）。
          onPartial: (files) => {
            void persistManifest({ ...current(), fileMtimes: files });
          },
          // 单段工作量上限。从最新往旧走，走满这一段先落一次盘、刷一次列表，
          // 让近期那批马上排到位；剩下的由外层循环接着走。
          maxCommits: opts?.maxCommits ?? HISTORY_WINDOW,
        });

        walkedTotal += res.walked;
        Object.assign(fileMtimes, res.files);

        // 落盘 + 刷列表：**每段一次**，这样用户很快看到近期排序，而不是等整段历史走完
        const merged = mergeRealMtimes(notesNow, fileMtimes);
        const nextMeta: Meta = {
          ...current(),
          notes: merged.notes,
          fileMtimes: { ...fileMtimes },
          histFrontier: res.frontier,
        };
        set({
          meta: nextMeta,
          order: Object.keys(nextMeta.notes).sort(byMtimeDesc(nextMeta)),
          histNote: `已核对 ${walkedTotal} 个提交，${merged.filled} 篇笔记的真实修改时间已更新`,
        });
        await persistManifest(nextMeta);

        note = `已核对 ${walkedTotal} 个提交，${merged.filled} 篇笔记的真实修改时间已更新`;
        more = res.more;
        // 前沿必须前进：不前进就说明这一段白走（本轮已经走完、或返回值有问题），
        // 再循环下去就是原地打转。宁可停下等下次同步，也不能死循环。
        if (!res.more || res.frontier === frontier) break;
        frontier = res.frontier;
      }

      set({ histDone: 0, histTotal: 0, histNote: walkedTotal > 0 ? note : '版本历史没有新变化' });
      if (more) {
        // 还有更旧的没走完 —— 说清楚"会自己接着做"，别让人以为卡住了
        set({ toast: '修改时间还在后台继续核对，会自己接着做' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({ histDone: 0, histTotal: 0, histNote: hint ? `${message}；${hint}` : message });
    }
  },

  async pullContent(options) {
    const run = doPullContent(options);
    pullRun = run;
    await run;
  },

  resumePullIfDue() {
    const { pullResumeAt, pullStage, meta, settings } = get();
    if (pullResumeAt <= 0) return; // 没排着自动续下，什么都不做
    if (pullStage !== '') return; // 正在拉，别叠第二份
    /*
     * 用 `pullStopRequested` 而不是 `pullPaused` 判断"用户叫停"。
     *
     * 额度用完时 `pullPaused` 也是 true（意思是"还有欠账、等着"），拿它当判据会把
     * 自动续下自己挡住 —— 而这时**恰恰是应该续**的时候。`pullStopRequested` 只由
     * `pauseContent()` 置位，才是"用户明确叫停"。
     */
    if (pullStopRequested) return;
    if (!isConfigured(settings)) return;
    if (Date.now() < pullResumeAt) {
      // 时刻还没到（定时器可能被冻结了），重新排一次，别让它永远醒不来
      scheduleAutoResume(pullResumeAt);
      return;
    }
    if (pendingContentCount(meta) === 0) {
      set({ pullResumeAt: 0 });
      return;
    }
    cancelAutoResume();
    set({ pullResumeAt: 0 });
    void get().pullContent();
  },

  pauseContent() {
    // 作废在途的自动续期：用户明确按了暂停，几分钟后它自己又跑起来是最坏的体验
    cancelAutoResume();
    set({ pullResumeAt: 0 });
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
    void get().saveSession(); // 新笔记马上就成了"当前在看的这篇"，状态要跟上去
  },

  async openNeighbor(direction: -1 | 1) {
    const { order, current } = get();
    if (!current) return;
    const at = order.indexOf(current);
    if (at < 0) return;
    const target = order[at + direction];
    // 到头了就什么也不做：按钮那边也会置灰，这里只是兜底
    if (!target) return;
    await get().openNote(target);
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
      // 打开哪篇就记哪篇：不能只靠"切后台时保存"那一次 —— Android 给 onPause 写完磁盘的
      // 窗口很短，异步写入可能没落完。状态一变就尽早写一次，最坏情况丢的也只是一小段。
      void get().saveSession();
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
      void get().saveSession(); // 同上：按需拉下来的这篇也立刻记成"当前在看的"
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
    // 路径变了，状态里的 current 必须跟着搬；否则下次打开会指向一个不存在的旧路径
    void get().saveSession();
  },

  async deleteNote() {
    if (!repo) return;
    const { current, meta } = get();
    if (!current) return;
    await repo.remove(current);
    const notes = { ...meta.notes };
    delete notes[current];
    // 留一块墓碑：清单里删掉之后，远端还留着这条；不留记录的话下次同步根本看不出
    // "本地删过"，删除就永远传不到远端（用户以为删了、其实还在）。
    // 只有**远端确实有**这条时才需要墓碑；本地新建后没推过的，删了就没了，不用惊动远端。
    // 墓碑要**自带**远端 sha：这条记录马上就不在 notes 里了，而"远端现在是什么"只记在
    // notes 里 —— 只留路径的话，推送时凑不出一份有效判定，删除会静默失效。
    const remoteSha = meta.notes[current]?.remoteSha ?? '';
    const removed = remoteSha
      ? [...meta.removed.filter((t) => t.path !== current), { path: current, remoteSha }]
      : meta.removed;
    const next = { ...meta, notes, removed };
    set({ meta: next, order: Object.keys(notes).sort(byMtimeDesc(next)), current: null, content: '', toast: `《${current}》已移入回收站` });
    // 当前笔记已经不在清单里了，状态里不能留着它（还原时会指向不存在的路径）
    void get().saveSession();
    await persistManifest(next);
  },

  setMode(mode) {
    set({ mode });
    // 阅读/编辑态是"离开时的样子"的一部分，切了就记一次
    void get().saveSession();
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
  async pushNow() {
    if (!repo) return;
    const first = get();
    if (!isConfigured(first.settings)) {
      set({ error: '还没有配置同步仓库：请在设置里填「仓库」与「访问令牌」' });
      return;
    }
    if (first.pushStage) return; // 已经在推，别叠第二份

    // 先把本地有哪些文件、都有什么内容算出来。
    //
    // 为什么要重建清单而不是信任 manifest：`localSha` 是我们自己维护的，一旦它在某个
    // 环节漂移，"以为没改"就会**漏推**。而漏推是静默的 —— 用户回到电脑上才发现改动不见了。
    // 重建的代价是读一遍本地笔记（手机上就几百篇有内容），换来的是"推送集合一定正确"。
    const local = await repo.buildManifest(first.meta.notes);
    // 重建只认磁盘，而磁盘上**没有远端 sha**（那是清单独有的记录）。所以重建完要把
    // 清单里的远端记录合回来，否则远端视图会变成空的："远端删了没有""远端有没有这条"
    // 全部判不出来 —— 表现就是删除永远传不出去。
    //
    // 两边的分工必须分清（合错方向会静默出错）：
    //   · **本地**（sha/大小/时间）以**重建结果**为准 —— 磁盘才是内容的权威；
    //   · **远端**（remoteSha/syncedSha/标记）以**清单**为准 —— 磁盘上根本没有这些信息。
    // 曾经写成 `{...清单, ...重建}`，看起来是"合回来了"，实际上重建里那些空 remoteSha
    // 把清单的记录又盖没了，症状和没合一样。
    const notes: Record<string, NoteEntry> = {};
    for (const [path, e] of Object.entries({ ...local.notes, ...first.meta.notes })) {
      const fresh = local.notes[path];
      const known = first.meta.notes[path];
      notes[path] = fresh
        ? { ...fresh, remoteSha: known?.remoteSha ?? '', syncedSha: known?.syncedSha ?? '' }
        : (e as NoteEntry);
    }

    const localMeta: Meta = { ...first.meta, notes };
    // 只把**磁盘上真的存在**的路径交给三方判定（它决定"本地有没有"）
    const localPaths = Object.keys(local.notes);
    // 没有改动时连远端都不问 —— 白花请求。
    //
    // **必须同时看脏标记和 diff**，缺一不可：只看脏标记会把"标记丢了但内容真变了"漏掉
    // （静默漏推）；只看 diff 又会把"改回原样但还带着脏标记"当成无改动而永远清不掉标记。
    // `push-new` 也要算：新建的笔记远端还没有，只要它带着脏标记就说明用户确实写了东西。
    //
    // **删除也要算**：删掉一篇之后清单里已经没有它了，脏标记当然也没有 ——
    // 只看脏标记的话"删了一篇"会被判成"没有改动"，删除就永远传不到远端。
    const wouldPush = pathsToPush(
      diffWithRemote(localMeta, remoteNotesOf(localMeta), localPaths),
      (path) => ((first.meta.notes[path]?.flags ?? 0) & FLAG.DIRTY) !== 0,
    );
    const wouldDelete = first.meta.removed.length > 0;
    if (dirtyCount(first.meta) === 0 && wouldPush.length === 0 && !wouldDelete) {
      set({ meta: localMeta, pushDirty: 0, toast: '本地没有改动，无需推送' });
      return;
    }

    set({ pushStage: '核对远端状态' });
    try {
      const settings = first.settings;
      const client = new GithubClient({
        token: settings.token,
        repo: settings.repo,
        branch: settings.branch,
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      // 先拉：把 lastCommit / lastTree 对齐到远端真实状态。
      // 拉完 diff 才可信 —— 否则可能是基于一个已经过时的基准在推送。
      const snap = await fetchSnapshot(client, {
        lastCommit: first.meta.lastCommit,
        lastEtag: first.meta.treeEtag,
      });

      let meta = localMeta;
      if (snap) {
        // 远端在我们上次同步之后动过：先把它的改动并进来再决定推什么。
        // 这里可能产生冲突（两侧都改），冲突的篇目不会被推 —— 交给冲突流程处理。
        meta = reconcileSnapshot(localMeta, snap);
      }
      set({
        meta,
        conflicts: conflictsOf(diffWithRemote(meta, remoteNotesOf(meta), localPaths), meta),
        order: Object.keys(meta.notes).sort(byMtimeDesc(meta)),
        pendingContent: pendingContentCount(meta),
        pushDirty: pathsToPush(diffWithRemote(meta, remoteNotesOf(meta), localPaths)).length,
      });
      if (!meta.lastCommit || !meta.lastTree) {
        set({ pushStage: '', error: '还没有同步过，无法确定推送的基准。请先同步一次。' });
        return;
      }

      // 三方判定：拿"清单里记的远端 sha"当远端视图。
      // 它刚被上面的 reconcile 对齐过，所以和直接读远端树等价，但**不用再下一次树**。
      const diff = diffWithRemote(meta, remoteNotesOf(meta), localPaths);
      const count = pathsToPush(diff).length + diff.deletedLocally.length;

      /*
       * **有冲突就拒绝推送。**
       *
       * 为什么不在这儿做"以哪边为准"的选择：mochi 是**辅助**软件，手机上本来就不该做
       * 多少编辑，而两个版本都是用户自己写的、哪边更重要只有他知道 —— 整篇覆盖型的
       * 二选一在手机上很难看清后果。所以这里只把撞车的篇目列清楚，请他回电脑上理顺，
       * 之后在手机上拉一次，那几篇会被远端版本覆盖（拉取本来就按 sha 不同来挑，
       * 不需要额外机制）。
       *
       * `pathsToPush` 本来就不会带上冲突的篇目，所以即使放行也不会覆盖远端 ——
       * 但那样会变成"静默少推几篇"，用户以为推成功了。宁可明确拒绝。
       */
      const blocked = conflictsOf(diff, meta);
      if (blocked.length > 0) {
        const names = blocked.slice(0, 3).map((c) => `《${displayTitle(c.path)}》`).join('、');
        const more = blocked.length > 3 ? ` 等 ${blocked.length} 篇` : '';
        set({
          pushStage: '',
          conflicts: blocked,
          error:
            `${names}${more}在手机上和在电脑上都被改过，没法判断该留哪一份，所以这次没有推送。\n` +
            '请先在电脑上把这几篇理顺并同步，再回到手机上点一次同步 —— 那几篇会被电脑上的版本覆盖。',
        });
        return;
      }

      set({ pushStage: `推送 ${count} 篇改动` });
      const outcome = await pushNotes({
        client,
        baseCommit: meta.lastCommit,
        baseTree: meta.lastTree,
        diff,
        // 只读"判定为要推"的那些文件：没改动的篇目一个字节都不读
        readNote: (path) => repo!.readTextIfPresent(path),
        // 只有用户真的改过（脏标记）的笔记才推。光"本地有、远端没有"不够 ——
        // 那可能只是还没下载完的缓存，或者清单重建后失去共同基准的旧笔记。
        isDirty: (path) => ((meta.notes[path]?.flags ?? 0) & FLAG.DIRTY) !== 0,
        expectedSha: (path) => meta.notes[path]?.localSha ?? '',
        message: pushMessage(pathsToPush(diff), diff.deletedLocally),
      });

      if (!outcome.ok) {
        // 失败一律保留脏标记（`markPushed` 只在成功时调用）——宁可重复推，绝不漏推
        set({ pushStage: '', error: `推送失败：${outcome.error ?? '原因未知'}` });
        return;
      }

      const after = markPushed(meta, outcome.written, outcome.deleted);
      // 提交前进了就记新的基准；没前进（空推）则保持原值
      const advanced = outcome.commit !== meta.lastCommit;
      const next: Meta = {
        ...after,
        lastCommit: advanced ? outcome.commit : meta.lastCommit,
        lastTree: advanced ? outcome.tree : meta.lastTree,
        lastSyncAt: advanced ? Date.now() : meta.lastSyncAt,
        // 树变了，条件请求的 ETag 就不能再用了（继续用会拿到 304 而漏掉自己的这次改动）
        treeEtag: advanced ? '' : meta.treeEtag,
      };
      set({
        meta: next,
        order: Object.keys(next.notes).sort(byMtimeDesc(next)),
        pushStage: '',
        pushDirty: dirtyCount(next),
        toast: advanced ? `已推送 ${outcome.written.length + outcome.deleted.length} 篇改动` : '本地没有需要推送的改动',
      });
      await persistManifest(next);
      // 推送成功才清 trash：那里是删除操作的兜底，同步成功前不能动
      for (const path of outcome.deleted) await repo.dropTrash(path).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = (err as { hint?: string }).hint;
      set({ pushStage: '', error: hint ? `${message}\n${hint}` : message });
    }
  },

  async saveSession() {
    if (!store) return;
    // 挂起的防抖写入必须作废：它带的是敲字当时的 query，会覆盖掉这次要写的会话
    cancelQuerySave();
    const { current, content, mode, dirty, scrollRatio, query } = get();
    const state: SessionState = {
      current,
      mode,
      scrollRatio,
      query,
      // 只有"改过且没保存"才存草稿：否则每次切后台都要写一遍整篇正文，白费 IO
      draft: dirty ? content : null,
    };
    try {
      await store.writeText(SESSION_FILE, serializeSession(state));
    } catch {
      // 存不上就算了：这是"下次回到原处"的便利，不该因为磁盘问题打断用户当前的操作
    }
  },
  async copyCurrentNote(options) {
    const { current, content } = get();
    if (!current) {
      set({ toast: '还没有打开任何笔记' });
      return;
    }
    try {
      await writeClipboardText(clipboardText(displayTitle(current), content, options));
      set({ ui: { ...get().ui, menu: false }, toast: '已复制，可以去别的应用粘贴了' });
    } catch (e) {
      // 复制失败必须说出来：让用户以为复制成功、结果粘出空内容，比直接报错糟得多
      set({ error: `复制失败：${e instanceof Error ? e.message : String(e)}` });
    }
  },
  dismissError() {
    set({ error: null });
  },
  setUi(key, open) {
    set({ ui: { ...get().ui, [key]: open } });
  },
  setError(message) {
    set({ error: message });
  },

  async setSearchQuery(query) {
    set({ query });
    // 关键词要能跨重启留住，所以这里就安排落盘；结果（rows）由关键词推出来，不必单独存
    scheduleQuerySave();
    const q = query.trim();
    if (!q) {
      set({ rows: [] });
      return;
    }
    const generation = ++searchGeneration;
    // 文件名命中：`order` 本身就按列表顺序排好，所以过滤出来天然是列表的一个子序列
    const nameHits = get().order.filter((p) => p.toLowerCase().includes(q.toLowerCase()));

    // 先只出文件名结果：这一步零 IO，敲字就有反馈
    set({ rows: nameHits.slice(0, SEARCH_LIMIT).map((path) => ({ path, kind: 'name' as const })) });

    const { meta } = get();
    const contentHits = searchIndex
      ? search(searchIndex, q, {
          // 搜索排序也走真实修改时间，否则「最近改的排前面」在手机上不成立
          // 排序交给下面的 `sortByTimeDesc`（与列表完全同一套）。
          // 若这里退回"落盘时刻"，同一批笔记在列表和搜索里的先后会不一致。
          mtimeOf: (path) => (hasRealMtime(meta.notes[path]) ? (meta.notes[path]?.fileMtime ?? 0) : 0),
          limit: SEARCH_LIMIT,
        }).map((hit) => hit.path)
      : [];

    // 两批命中**统一排序再截断**：搜索结果是列表顺序的一个子序列。
    // 先各自截断再拼会让"最近改的排前面"在搜索里不成立（截断发生在排序之前）。
    const content = orderPaths(
      contentHits.filter((p) => !nameHits.includes(p)),
      meta,
    );
    if (content.length === 0) return;

    // 读命中笔记的正文来生成摘要。只读命中的那些（最多 SEARCH_LIMIT 篇），
    // 不做全库扫描 —— 这正是"搜索零读盘"的边界：排序零读盘，展示摘要要读命中的几篇。
    const snippets = new Map<string, { snippet: string; hl?: [number, number] }>();
    /*
     * 顺手核对："命中的词真的在这篇正文里吗"。
     *
     * 搜索只查倒排表、从不回头看正文，而倒排表是增量维护的；万一某一步漏摘，就会
     * 搜出一篇根本没有这个词的笔记，**而且看起来完全像真的**（有标题、有摘要、命中处
     * 还画着下划线）—— 用户会以为自己记错了，比"搜不到"糟得多。
     *
     * 这一段本来就要读正文做摘要，所以核对不额外读盘。对不上就**不列这条**：
     * 一个指向不存在内容的命中，比少一条结果更坏。同时记下次数，便于事后追查。
     */
    const dropped: string[] = [];
    if (repo) {
      const want = new Set(content.slice(0, SEARCH_LIMIT));
      await Promise.all(
        [...want].map(async (path) => {
          const text = await repo!.readTextIfPresent(path);
          if (text === null) return;
          if (!textHasQuery(text, q)) {
            dropped.push(path);
            return;
          }
          snippets.set(path, snippetFor(text, q.split(/\s+/)[0] ?? q));
        }),
      );
    }
    if (generation !== searchGeneration) return; // 用户又敲了字，这批结果已经过期

    // 核对没过的从结果里剔除（文件名命中不受影响：那是"找那篇叫 X 的笔记"，另当别论）
    const verified = dropped.length > 0 ? content.filter((p) => !dropped.includes(p)) : content;
    set({
      rows: mergeRows(
        nameHits,
        verified,
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

      /*
       * 一致性核对：确认"索引里挂着某个词的笔记，正文里真的有这个词"。
       *
       * 为什么需要它：搜索只查倒排表，从不回头看正文。而倒排表是增量维护的
       * （摘旧 gram、挂新 gram），万一某一步漏摘，表现就是**搜一个词、搜出一篇根本
       * 没有这个词的笔记** —— 这类 bug 读代码看不出来，每个环节单独看都对。
       *
       * 代价：对已索引的笔记各读一遍正文。放在后台分批建索引的这条路上，代价可接受；
       * 结果不弹窗、只落到 `lastSyncNote`，避免把内部状态泄漏给界面。
       */
      if (batch.length > 0) {
        const drift = auditIndexAgainstText(
          index,
          batch.map((b) => b.path),
          (path) => batch.find((b) => b.path === path)?.content ?? null,
        );
        const stale = drift.filter((d) => d.extraGrams > 0);
        if (stale.length > 0) {
          set({
            lastSyncNote: `索引自检发现 ${stale.length} 篇的命中可能对不上正文，已重建这几篇的索引`,
          });
          // 有假命中来源就直接把这些篇重灌一遍，从当前正文重建它们的 gram
          for (const d of stale) {
            const note = batch.find((b) => b.path === d.path);
            if (note) updateNote(index, { path: note.path, content: note.content, sha: note.sha });
          }
          indexVersion += 1;
          await saveIndex(store!, index);
          indexSavedVersion = indexVersion;
        }
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
  // 同时作废在途的自动续期：这一次已经在跑了，不需要它再来叫一遍
  cancelAutoResume();
  set({ pullPaused: false, pullResumeAt: 0 });

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
  /** 因为额度用完而收手时的恢复时刻（0 = 不是这个原因）。 */
  let quotaPausedUntil = 0;

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
        // 额度见底就收手：留一点给同步/推送/打开笔记时的补拉，剩下的下次接着下
        quota: () => client.remainingQuota,
      });

      for (const path of result.failed) failed.add(path);
      totalOk += result.ok.length;
      totalFailed += result.failed.length;
      if (result.quotaPausedUntil) quotaPausedUntil = result.quotaPausedUntil;
      // 每轮结束落一次盘即可：逐篇写会伤闪存，且真中断了也只是重下
      await persistManifest(get().meta);
      if (result.stopped) break;
    }

    if (stale()) return; // 已被新一代取代，别把它的状态覆盖掉
    // 索引按批落盘：逐篇写会伤闪存，而真中断了也只是重建一次
    await flushIndex();
    const pending = pendingContentCount(get().meta);
    const stopped = pullStopRequested;
    // 三种收尾要分开说：用户按了暂停、额度用完、正常下完。
    // 混成一句含糊的"已暂停"，用户就不知道"是我停的？还是坏了？还要不要管它？"
    const quotaWait = quotaPausedUntil ? humanizeWait(Math.max(0, quotaPausedUntil - Date.now())) : '';
    // 额度用完了、而且确实还有欠账 → 排一次自动续下，到点自己接着跑，不用用户盯着
    const willAutoResume = Boolean(quotaPausedUntil) && pending > 0;
    const note = quotaPausedUntil
      ? `本小时额度用完：本次下好 ${totalOk} 篇，还差 ${pending} 篇，${quotaWait}后自动接着下`
      : stopped
        ? `已暂停：本次下好 ${totalOk} 篇，还差 ${pending} 篇`
        : `内容已就绪：本次下好 ${totalOk} 篇${totalFailed ? `，${totalFailed} 篇失败` : ''}，还差 ${pending} 篇`;
    set({
      pullStage: '',
      pendingContent: pending,
      pullPaused: (stopped || Boolean(quotaPausedUntil)) && pending > 0,
      pullResumeAt: willAutoResume ? quotaPausedUntil : 0,
      lastSyncNote: note,
      ...(totalOk > 0 && !stopped && !quotaPausedUntil ? { toast: `已下载 ${totalOk} 篇笔记内容` } : {}),
    });
    if (willAutoResume) scheduleAutoResume(quotaPausedUntil);
    else cancelAutoResume();
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

/** 等正在跑的历史整理结束（端到端自测用）。理由同 __awaitContentPullForTest。 */
export async function __awaitMtimeRefreshForTest(): Promise<void> {
  while (histRun) {
    const run = histRun;
    await run.catch(() => {});
    if (histRun === run) histRun = null;
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

/**
 * 直接塞一份搜索索引（测试用）。
 *
 * 为什么需要：要复现"索引与正文不一致"这种状态，只能绕过正常的更新路径去构造它 ——
 * 正常路径恰恰是**会**保持一致的。没有这个口子，这类 bug 就永远测不到。
 */
export function __setSearchIndexForTest(index: SearchIndex | null): void {
  searchIndex = index;
}
