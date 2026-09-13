/**
 * 冲突的识别。
 *
 * 什么时候算冲突：**手机和电脑都改过同一篇**。拉取时会发现两侧的 sha 都和上次同步的
 * 基准不同，此时既不能拿远端盖掉手机上的改动（用户刚写的东西没了），也不能拿手机盖掉
 * 远端（电脑上写的没了）。
 *
 * **这边的立场是"不替用户做决定"，而且不做复杂的合并**：mochi 是**辅助**软件，手机上
 * 本来就不该做多少编辑。所以遇到冲突的处理是**拒绝推送**并把撞车的篇目列出来，
 * 让用户回电脑上把版本理顺，再在手机上拉一次覆盖掉本机那几篇。
 *
 * 这样比在手机上做"以哪边为准"的三选一更简单，也更不容易出错 —— 手机上那两个版本都是
 * 用户自己写的，哪边更重要只有用户知道，而整篇覆盖型的二选一在手机上很难看清楚后果。
 *
 * 这里只做**纯计算**：判定与记账，不碰网络也不碰磁盘。
 */
import { type DiffResult, type Meta } from './manifest';

/** 一批待决冲突里的一条。 */
export interface ConflictItem {
  path: string;
  /** 本地这一版的内容 sha。 */
  localSha: string;
  /** 远端当前那一版的 sha。 */
  remoteSha: string;
  /** 上次同步时的共同基准；空串表示没有共同基准（清单重建过之类）。 */
  syncedSha: string;
}

/**
 * 从三方判定结果里挑出待决冲突。
 *
 * 只认 `kind === 'conflict'`：那一项是判定函数算出来的，**不在这里重新判一遍**。
 * 重判会出现"界面说有冲突、推送却不认为有"这种两套口径打架的情况，而两边各写一遍
 * 判定逻辑迟早会漂移。
 */
export function conflictsOf(diff: DiffResult, meta: Meta): ConflictItem[] {
  const out: ConflictItem[] = [];
  for (const c of diff.changes) {
    if (c.kind !== 'conflict') continue;
    const e = meta.notes[c.path];
    if (!e) continue;
    out.push({
      path: c.path,
      localSha: e.localSha,
      remoteSha: e.remoteSha,
      syncedSha: e.syncedSha,
    });
  }
  return out;
}

/** 把待决冲突的路径记进清单，供界面显示。 */
export function withConflicts(meta: Meta, items: readonly ConflictItem[]): Meta {
  return { ...meta, conflicts: items.map((i) => i.path) };
}
