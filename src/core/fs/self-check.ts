/**
 * 自检：把"本地缓存和清单是否还对得上"这件事算清楚，供诊断页显示。
 *
 * **为什么需要它**：mochi 的本地目录是可重建的缓存，唯一的事实来源是清单（manifest）。
 * 于是有一类故障特别难自查 —— 清单说某篇已下载、磁盘上其实没有，表现是"点开一片空白"；
 * 或者磁盘上多出一篇清单不认的文件，表现是"列表里找不到但搜索能搜到"。
 * 这类问题光看界面看不出来，得把两侧摆在一起数。
 *
 * 这里**只读不修**：诊断页的职责是告诉用户发生了什么，不该在用户看的时候顺手改数据
 * （那会把现场毁掉，下次更难查）。
 *
 * 判定口径统一用 `manifest.ts` 里已有的那几个函数（`hasRealMtime`、
 * `pendingContentCount`、`dirtyCount`），不另写一套 —— 两套口径迟早会漂移，
 * 而漂移之后"自检说没问题"就不再可信了。
 */
import type { FileStore } from '../fs/store';
import { NOTES_DIR } from '../fs/layout';
import { dirtyCount, hasRealMtime, type Meta, type NoteEntry } from '../sync/manifest';

/** 清单与磁盘对不上的一篇。 */
export interface Mismatch {
  path: string;
  /** 对不上的方式。 */
  kind: '清单说有、磁盘没有' | '磁盘有、清单没有' | '大小对不上';
  /** 便于判断严重程度：清单记的字节数（没有则为 0）。 */
  expected: number;
  /** 磁盘上的字节数（没有则为 0）。 */
  actual: number;
}

export interface SelfCheck {
  /** 清单里的篇数。 */
  total: number;
  /** 本地拿得到内容的篇数（按大小 > 0 判定）。 */
  onDisk: number;
  /** 内容还没下载的篇数。 */
  missingContent: number;
  /** **修改时间还不知道**的篇数 —— 这些篇目在列表里排不准。 */
  unknownMtime: number;
  /** 待推送（本地改过）的篇数。 */
  dirty: number;
  /** 待决冲突的篇数。 */
  conflicts: number;
  /** 对不上的篇目（最多留前若干条，避免诊断页被刷屏）。 */
  mismatches: Mismatch[];
  /** 对不上的总条数（`mismatches` 可能被截断）。 */
  mismatchTotal: number;
}

/** 对不上的篇目最多列这么多条：诊断页是拿来看的，不是拿来存档的。 */
export const MISMATCH_LIMIT = 20;

/**
 * 跑一次自检。
 *
 * 只读一次目录（`notes/`），不做逐篇读文件内容那种重活 —— 诊断页要能随时打开，
 * 不能打开就转半天。所以"内容对不对"只看**大小**，不算 sha；大小对不上足够说明问题，
 * 而大小对得上却内容不同的情况在正常使用里出不来（写入都走同一套 sha 记账）。
 */
export async function selfCheck(store: FileStore, meta: Meta): Promise<SelfCheck> {
  const entries = await store.list(NOTES_DIR);
  const onDisk = new Map<string, number>();
  for (const e of entries) {
    // 目录里可能混着子目录之类的意外条目，大小拿不到就按 0 算，仍然能报"清单说有、磁盘没有"
    onDisk.set(e.name, e.size ?? 0);
  }

  const mismatches: Mismatch[] = [];
  let missingContent = 0;
  let unknownMtime = 0;
  let diskCount = 0;
  let total = 0;

  for (const [path, e] of Object.entries(meta.notes) as [string, NoteEntry][]) {
    total += 1;
    if (!hasRealMtime(e)) unknownMtime += 1;
    // **先数"内容没下"再判磁盘**：这两件事互相独立，文件不在和内容没下都要各报一次。
    // 曾经放在 `continue` 之后，于是"清单说有、磁盘没有"的篇目永远不会被算进待下载数 ——
    // 表现是诊断页说"没有待下载的"，实际有一堆点开是空的。
    if (!e.localSha) missingContent += 1;
    const size = onDisk.get(path);
    if (size === undefined) {
      // 远端都没这篇的 sha，那它本来就不该在本地（清单里留着是为了记住"远端删过"之类）
      if (e.remoteSha) mismatches.push({ path, kind: '清单说有、磁盘没有', expected: e.size, actual: 0 });
      continue;
    }
    diskCount += 1;
    onDisk.delete(path);
    if (e.size > 0 && size !== e.size) {
      mismatches.push({ path, kind: '大小对不上', expected: e.size, actual: size });
    }
  }

  // 剩下的就是"磁盘有、清单没有"：多半是上次删文件删到一半、或者清单被重建过
  for (const [path, size] of onDisk) {
    mismatches.push({ path, kind: '磁盘有、清单没有', expected: 0, actual: size });
  }

  return {
    total,
    onDisk: diskCount,
    missingContent,
    unknownMtime,
    dirty: dirtyCount(meta),
    conflicts: meta.conflicts.length,
    mismatches: mismatches.slice(0, MISMATCH_LIMIT),
    mismatchTotal: mismatches.length,
  };
}

/** 自检有没有发现需要用户知道的问题（诊断页据此决定要不要标红）。 */
export function hasProblem(c: SelfCheck): boolean {
  return c.mismatchTotal > 0 || c.conflicts > 0 || c.missingContent > 0;
}
