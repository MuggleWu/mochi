/**
 * 笔记清单（manifest）与同步判定。
 *
 * 这是同步的核心数据结构：**列表、搜索、排序、改动检测全部只读它，从不读文件**。
 * 它必须持久化到手机本地（`state/manifest.json`），冷启动解析后常驻内存。
 *
 * 关键教训（来自 miki 的真机事故）：`syncedSha` 必须持久化。
 * 少了它，一个冲突文件在下次同步时会被判成"两侧都没变"而**静默跳过**，
 * 分叉永不收敛。
 */

/** 笔记状态位。 */
export const FLAG = {
  /** 本地有未推送的改动。 */
  DIRTY: 1,
  /** 远端已删除，本地还在。 */
  REMOTE_DELETED: 2,
  /** 冲突待决（已记入 Meta.conflicts）。 */
  CONFLICT: 4,
  /** 只有元数据，内容尚未下载（分级拉取的 L1/L2 未轮到）。 */
  METADATA_ONLY: 8,
} as const;

export interface NoteEntry {
  /** 笔记名（含 `.md`，即仓库根目录下的文件名）。 */
  path: string;
  /** 本地内容 sha；没有本地文件时为空串。 */
  localSha: string;
  /** 上次见到的远端 sha。 */
  remoteSha: string;
  /** 两侧一致时的 sha —— 三方判定的基准。 */
  syncedSha: string;
  /** 字节数（远端给出或本地算出）。 */
  size: number;
  /**
   * 修改时间（毫秒）；排序只用它。
   *
   * **它不是真实修改时间**，是"下载落盘那一刻"（git 树里根本没有文件修改时间字段）。
   * 取它的目的是顺序稳定。真实修改时间在 `fileMtime`。
   */
  mtime: number;
  /**
   * 真实最后修改时间（毫秒），从版本历史反推出来。
   *
   * 0 = 还不知道。**显示与排序一律优先用它**，为 0 时才退回 `mtime`（并如实标注）。
   * 反推的代价与做法见 `core/history/mtime.ts`。
   */
  fileMtime: number;
  flags: number;
}

/**
 * 排序与显示该用哪个时间：真实修改时间优先，没有才退回落盘时间。
 *
 * 放在这里而不是各调用点各写一遍：两处（抽屉排序、界面显示）如果各写各的，
 * 迟早出现"排的是真实时间、显示的是落盘时间"这种对不上的情况。
 */
export function effectiveMtime(e: NoteEntry | undefined): number {
  if (!e) return 0;
  return e.fileMtime > 0 ? e.fileMtime : e.mtime;
}

/** 这篇笔记的时间是不是真实修改时间（界面据此决定要不要标"时间未知"）。 */
export function hasRealMtime(e: NoteEntry | undefined): boolean {
  return (e?.fileMtime ?? 0) > 0;
}

/**
 * 还有多少篇的内容没下载（localSha 与 remoteSha 不一致的都算）。
 *
 * 判定只看 localSha === remoteSha 这一条：状态只有清单这一份，
 * 不会出现"标记说下过了但文件其实没了"的漂移。
 */
export function pendingContentCount(meta: Meta): number {
  let n = 0;
  for (const path of Object.keys(meta.notes)) {
    const e = meta.notes[path];
    if (!e || !e.remoteSha) continue;
    if (e.localSha !== e.remoteSha) n++;
  }
  return n;
}

export interface Meta {
  schemaVersion: number;
  /** 目标仓库，形如 `owner/repo`（由用户在设置里填，不写进代码）。 */
  repo: string;
  /** 分支名。 */
  branch: string;
  /** 上次同步到的远端提交。 */
  lastCommit: string;
  /** 上次同步的根树 sha（推送时作为 base_tree）。 */
  lastTree: string;
  /**
   * 上次递归树响应的 ETag。树没变时用它发条件请求，GitHub 回 304、0 字节。
   * 实测一万篇的仓库，树响应 660 KB、下载要 23 秒，而 304 只要 1.1 秒 —— 差 20 倍。
   */
  treeEtag: string;
  /** 笔记清单，键为 path。 */
  notes: Record<string, NoteEntry>;
  /** 尚未解决的冲突（必须持久化，见文件头注释）。 */
  conflicts: string[];
  /**
   * 本地已删、但**还没同步到远端**的路径（墓碑）。
   *
   * 为什么必须在清单里留个记录：删掉之后清单里就没有这条了，远端却还有 ——
   * 下一次同步只能看到"远端有、本地没有"，而"本地没删过"和"本地删了但还没推"在
   * 清单上看**一模一样**。少了这个记录，删除永远传不到远端，用户会以为删了、其实还在。
   * 推送成功后才清掉它，并把 trash 里的备份一起清掉。
   */
  removed: string[];
  /** 上次成功同步的时间。 */
  lastSyncAt: number;
  /**
   * 反推出来的"路径 → 真实修改时间"。
   *
   * 与逐条的 `NoteEntry.fileMtime` 内容相同，**故意冗余**：整理历史时每批要把中间
   * 结果落盘，而落盘走的是"重建一篇清单"，那会丢掉 `NoteEntry` 上刚算出来、还没并进去
   * 的部分。留一份原始映射，中断续传时才能接着上次的结果继续（详见 `core/history/mtime.ts`）。
   */
  fileMtimes: Record<string, number>;
  /**
   * 版本历史整理到哪个提交（"真实修改时间"的前沿）。
   *
   * 空串 = 从没整理过。下次从它那里接着走，所以日常同步只多 1 个请求。
   * 它不在历史里了说明历史被重写过，届时整段重来（见 `core/history/mtime.ts`）。
   */
  histFrontier: string;
}

export const SCHEMA_VERSION = 1;

export function emptyMeta(repo = '', branch = 'master'): Meta {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo,
    branch,
    lastCommit: '',
    lastTree: '',
    treeEtag: '',
    notes: {},
    conflicts: [],
    removed: [],
    lastSyncAt: 0,
    fileMtimes: {},
    histFrontier: '',
  };
}

export function isDirty(e: NoteEntry): boolean {
  return (e.flags & FLAG.DIRTY) !== 0;
}

export function isMetadataOnly(e: NoteEntry): boolean {
  return (e.flags & FLAG.METADATA_ONLY) !== 0;
}

/** 逐文件的三方判定结果。 */
export type ChangeKind =
  /** 只有远端变了 → 落远端。 */
  | 'take-remote'
  /** 只有本地变了 → 推本地。 */
  | 'push-local'
  /** 两侧都变了 → 走冲突流程。 */
  | 'conflict'
  /** 本地新增（从未同步过，远端没有）。 */
  | 'push-new'
  /** 远端新增。 */
  | 'pull-new'
  /** 两侧都没变。 */
  | 'skip';

export interface Change {
  kind: ChangeKind;
  path: string;
}

/** 远端树里的一行（我们只关心根目录 markdown）。 */
export interface RemoteNote {
  path: string;
  /** blob sha。 */
  sha: string;
  size: number;
}

export interface DiffResult {
  changes: Change[];
  /** 远端已删除且本地没动过 → 本地也该删。 */
  deletedLocally: string[];
  /** 远端已删除但本地有改动 → 保留本地（用户的选择），置 REMOTE_DELETED。 */
  keepDeletedLocally: string[];
  /** 远端新增的笔记（需要下载内容）。 */
  addedRemotely: string[];
  /** 本地有内容但远端没有、且从未同步过（首次同步时可能存在）。 */
  unpushed: string[];
  /** 本地已删、还没同步到远端的路径（清单里的墓碑，远端也要跟着删）。 */
  removedLocally: string[];
}

/**
 * 三方判定：以 `syncedSha` 为基准，逐文件决定动作。
 *
 * 判定只用 sha 比较，**不读文件内容** —— 本地 sha 在下载落盘或编辑保存时算好。
 */
export function diffWithRemote(meta: Meta, remote: RemoteNote[], newLocalPaths: string[] = []): DiffResult {
  const changes: Change[] = [];
  // 墓碑：本地删过、远端还在 —— 远端也要删。远端已经没有了就顺手清掉墓碑（已经一致了）。
  const remoteNow = new Set(remote.map((r) => r.path));
  const removedLocally = meta.removed.filter((p) => remoteNow.has(p));
  // 墓碑路径要从"远端新增"里排除掉 —— 否则它会**同时**被判为待删除和待拉取，
  // 结果是把刚删掉的笔记又下载回来，用户看到的还是"删了又回来了"。
  const tombstoned = new Set(removedLocally);
  const deletedLocally: string[] = [];
  const keepDeletedLocally: string[] = [];
  const addedRemotely: string[] = [];
  const unpushed: string[] = [];
  const seen = new Set<string>();

  for (const r of remote) {
    if (tombstoned.has(r.path)) continue; // 本地删过、还没推到远端：只等推送去删，不要拉回来
    seen.add(r.path);
    const note = meta.notes[r.path];
    if (!note || !note.syncedSha) {
      if (!note) {
        // 从未见过、远端有 → 拉
        changes.push({ kind: 'pull-new', path: r.path });
        addedRemotely.push(r.path);
      } else if (note.localSha && note.localSha !== r.sha) {
        // 本地有内容、与远端不同、又没有共同基准 → 只能当冲突处理
        changes.push({ kind: 'conflict', path: r.path });
      } else {
        // 内容恰好相同（例如刚推送过但记账丢了）→ 直接认账
        changes.push({ kind: 'skip', path: r.path });
      }
      continue;
    }

    const localChanged = note.localSha !== note.syncedSha;
    const remoteChanged = r.sha !== note.syncedSha;

    if (localChanged && remoteChanged) changes.push({ kind: 'conflict', path: r.path });
    else if (remoteChanged) changes.push({ kind: 'take-remote', path: r.path });
    else if (localChanged) changes.push({ kind: 'push-local', path: r.path });
    else changes.push({ kind: 'skip', path: r.path });
  }

  for (const [path, note] of Object.entries(meta.notes)) {
    if (seen.has(path)) continue;
    if (!note.syncedSha) {
      // 远端没有、又没有共同基准：本地确实还有内容才算待推送（空壳条目直接丢弃）
      if (note.localSha) unpushed.push(path);
      continue;
    }
    // 远端已删：本地动过就保留（置 REMOTE_DELETED），没动过就跟着删
    if (note.localSha !== note.syncedSha) keepDeletedLocally.push(path);
    else deletedLocally.push(path);
  }

  for (const path of newLocalPaths) {
    if (seen.has(path)) continue; // 远端也有 → 上面已归类
    if (meta.notes[path]) continue; // 清单里已有 → 已归类
    unpushed.push(path);
  }

  return { changes, deletedLocally, keepDeletedLocally, addedRemotely, unpushed, removedLocally };
}

/** 判定结果摘要，用于界面提示。 */
export interface DiffSummary {
  toPull: number;
  toPush: number;
  conflicts: number;
  toDelete: number;
  keptLocal: number;
  unchanged: number;
}

export function summarize(d: DiffResult): DiffSummary {
  let toPull = 0;
  let toPush = 0;
  let conflicts = 0;
  let unchanged = 0;
  for (const c of d.changes) {
    if (c.kind === 'take-remote' || c.kind === 'pull-new') toPull += 1;
    else if (c.kind === 'push-local' || c.kind === 'push-new') toPush += 1;
    else if (c.kind === 'conflict') conflicts += 1;
    else unchanged += 1;
  }
  if (d.unpushed.length) toPush += d.unpushed.length;
  return {
    toPull,
    toPush,
    conflicts,
    toDelete: d.deletedLocally.length + d.removedLocally.length,
    keptLocal: d.keepDeletedLocally.length,
    unchanged,
  };
}

/** 序列化：省略默认值，让 manifest 尽量小（10,070 篇）。 */
export function serializeMeta(meta: Meta): string {
  const notes: Record<string, unknown[]> = {};
  for (const [path, n] of Object.entries(meta.notes)) {
    // 数组形式比对象形式省下大量重复的键名。
    // fileMtime 追加在**末尾**：老清单读回来时多余的项会被忽略、缺的按默认处理，
    // 所以不用升 schemaVersion（版本号是硬校验，一动老清单就全读不出来了）。
    notes[path] = [n.localSha, n.remoteSha, n.syncedSha, n.size, n.mtime, n.flags, n.fileMtime];
  }
  return JSON.stringify({
    v: meta.schemaVersion,
    repo: meta.repo,
    branch: meta.branch,
    lastCommit: meta.lastCommit,
    lastTree: meta.lastTree,
    treeEtag: meta.treeEtag,
    conflicts: meta.conflicts,
    removed: meta.removed,
    lastSyncAt: meta.lastSyncAt,
    fileMtimes: meta.fileMtimes,
    histFrontier: meta.histFrontier,
    notes,
  });
}

export class MetaFormatError extends Error {}

export function deserializeMeta(text: string): Meta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MetaFormatError('清单文件损坏（JSON 解析失败）');
  }
  if (typeof raw !== 'object' || raw === null) throw new MetaFormatError('清单格式不对');
  const o = raw as Record<string, unknown>;
  const v = o['v'];
  if (v !== SCHEMA_VERSION) throw new MetaFormatError(`清单版本不支持：${String(v)}`);

  const meta = emptyMeta(typeof o['repo'] === 'string' ? o['repo'] : '', typeof o['branch'] === 'string' ? o['branch'] : 'master');
  meta.lastCommit = typeof o['lastCommit'] === 'string' ? o['lastCommit'] : '';
  meta.lastTree = typeof o['lastTree'] === 'string' ? o['lastTree'] : '';
  meta.treeEtag = typeof o['treeEtag'] === 'string' ? o['treeEtag'] : '';
  meta.conflicts = Array.isArray(o['conflicts']) ? o['conflicts'].filter((x): x is string => typeof x === 'string') : [];
  // 老清单没有这个字段 → 当成"没有待同步的删除"（默认值，不是错误）
  meta.removed = Array.isArray(o['removed']) ? o['removed'].filter((x): x is string => typeof x === 'string') : [];
  meta.lastSyncAt = typeof o['lastSyncAt'] === 'number' ? o['lastSyncAt'] : 0;
  meta.histFrontier = typeof o['histFrontier'] === 'string' ? o['histFrontier'] : '';
  const fm = o['fileMtimes'];
  if (typeof fm === 'object' && fm !== null && !Array.isArray(fm)) {
    for (const [k, v] of Object.entries(fm as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) meta.fileMtimes[k] = v;
    }
  }

  const notes = o['notes'];
  if (typeof notes === 'object' && notes !== null) {
    for (const [path, tuple] of Object.entries(notes as Record<string, unknown>)) {
      if (!Array.isArray(tuple)) continue;
      const [localSha, remoteSha, syncedSha, size, mtime, flags, fileMtime] = tuple as unknown[];
      meta.notes[path] = {
        path,
        localSha: typeof localSha === 'string' ? localSha : '',
        remoteSha: typeof remoteSha === 'string' ? remoteSha : '',
        syncedSha: typeof syncedSha === 'string' ? syncedSha : '',
        size: typeof size === 'number' ? size : 0,
        mtime: typeof mtime === 'number' ? mtime : 0,
        // 老清单没有这一项 → 默认 0（= 未知），界面会如实标注"时间未知"，不假装有时间
        fileMtime: typeof fileMtime === 'number' ? fileMtime : 0,
        flags: typeof flags === 'number' ? flags : 0,
      };
    }
  }
  return meta;
}

/** 本地改动待推送的篇数（`FLAG.DIRTY`）。界面用它决定"推送"按钮要不要提醒。 */
export function dirtyCount(meta: Meta): number {
  let n = 0;
  for (const e of Object.values(meta.notes)) if (e.flags & FLAG.DIRTY) n += 1;
  return n;
}

/**
 * 推送成功后更新清单。
 *
 * 只有**确认写进远端**的路径才被认账；`skipped`（推送期间又被改过的那些）保持原样，
 * 于是它们仍是脏的、下次会带上最新内容再推一遍。删掉的条目直接移除。
 *
 * 注意这里**不重算 `localSha`**：它是"本地内容的 sha"，由保存/下载时算好；
 * 推送只是确认"这个 sha 已经和远端一致了"，不该反过来改它。
 */
export function markPushed(meta: Meta, written: readonly string[], deleted: readonly string[]): Meta {
  const notes = { ...meta.notes };
  for (const path of written) {
    const e = notes[path];
    if (!e) continue;
    notes[path] = { ...e, remoteSha: e.localSha, syncedSha: e.localSha, flags: e.flags & ~FLAG.DIRTY };
  }
  for (const path of deleted) delete notes[path];
  // 删除确认生效，墓碑就可以撤了 —— 之后再同步也不会把"远端没有"误判成"没删过"
  const gone = new Set(deleted);
  return { ...meta, notes, removed: meta.removed.filter((p) => !gone.has(p)) };
}
