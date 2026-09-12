/**
 * 内容分级拉取（L1 / L2 / L3）。
 *
 * 设计动机（用户 D4 拍的板）：首启"能立刻用、搜索命中面逐步变全"。
 * 元数据先到 → 列表与文件名搜索立刻可用 → 内容分级补齐：
 *
 * | 层级 | 时机 | 范围 |
 * |---|---|---|
 * | L1 立即 | 首启/手动同步后 | 最近修改的 300 篇，保证"打开就能读" |
 * | L2 后台 | 空闲时继续补齐 | 其余笔记，带进度、可暂停 |
 * | L3 按需 | 打开某篇时 | 未下载且有网就地拉，无网如实说"尚未下载" |
 *
 * 为什么值得单独一层：一万篇按 41 MB 算，串行全量下载在实测的 28 KB/s 下要几十分钟。
 * 分层让"最常用的那部分先可用"，而不是等全量。
 *
 * 并发取 6：设计文档 §289 定的是 4–8（不追求极限，避开二次限流）。
 */

/** 首屏要拉多少篇。300 是设计文档定的出口标准（"最近 300 篇可读"）。 */
export const L1_COUNT = 300;

/** 并发数。设计文档 §289：4–8，不追求极限。 */
export const CONCURRENCY = 6;

export interface PlanInput {
  /** 全部笔记名，**必须已按 mtime 倒序**（列表就是这么排的）。 */
  order: string[];
  /** 每篇的 sha 信息：localSha 为空 = 本地没内容。 */
  notes: Record<string, { localSha: string; remoteSha: string }>;
  /** 本次最多取多少篇（L1 就是 L1_COUNT；L2 传剩余全部）。 */
  limit?: number;
  /** 跳过列表：本次已经试过且失败的，不要在同一次运行里反复重试。 */
  skip?: ReadonlySet<string>;
}

export interface Plan {
  /** 本次要下载的笔记名，仍按 mtime 倒序。 */
  paths: string[];
  /** 还有多少篇没下载（含本次要下的）。用于显示"内容 123/10070"。 */
  pendingTotal: number;
}

/**
 * 挑出本次要下载的笔记。
 *
 * "需要下载"的判定是 `localSha !== remoteSha`：两边都有且相等就跳过。
 * 这样 L2 重跑、同步后补拉都能复用同一套逻辑，不需要额外的"下载过没有"标记 ——
 * 状态只有一份（manifest），不会出现"标记说下过了但文件其实没了"这种漂移。
 */
export function planDownloads(input: PlanInput): Plan {
  const { order, notes, limit, skip } = input;
  const needs: string[] = [];
  for (const path of order) {
    const entry = notes[path];
    if (!entry) continue;
    // remoteSha 为空说明远端都没这篇的 sha，下不了
    if (!entry.remoteSha) continue;
    if (entry.localSha === entry.remoteSha) continue; // 已有且一致
    if (skip?.has(path)) continue;
    needs.push(path);
  }
  return {
    paths: limit === undefined ? needs : needs.slice(0, limit),
    pendingTotal: needs.length,
  };
}

/** 进度回调的载荷。 */
export interface Progress {
  /** 已完成篇数（含失败）。 */
  done: number;
  /** 本次计划总篇数。 */
  total: number;
  /** 成功的篇数。 */
  ok: number;
  /** 失败的篇数。 */
  failed: number;
  /** 本次运行累计下载字节数。 */
  bytes: number;
}

export interface RunOptions {
  /** 要下载的笔记名。 */
  paths: string[];
  /** 读远端 blob 文本。失败时抛错。 */
  fetchText(sha: string): Promise<string>;
  /** 取某篇当前的远端 sha。 */
  remoteShaOf(path: string): string | undefined;
  /** 接受内容（写盘 + 校验 sha）。返回 null 表示内容与远端 sha 不符，按失败处理。 */
  accept(path: string, content: string, remoteSha: string): Promise<boolean>;
  /** 每完成一篇调一次（含失败）。 */
  onProgress?(p: Progress): void;
  /**
   * 返回 true 表示要停：当前批次跑完就退出（已下好的保留，重启从剩下的继续）。
   *
   * 两种情况都走它：用户点了暂停，或者这次运行已经被作废（例如端到端自测里
   * 换了假网络，上一次的运行必须让位，否则会拿新网络去下旧任务）。
   */
  shouldStop?(): boolean;
  concurrency?: number;
}

export interface RunResult {
  ok: string[];
  failed: string[];
  bytes: number;
  /** 是否因为 shouldStop() 而提前结束。 */
  stopped: boolean;
}

/**
 * 并发下载。用固定数量的 worker 轮流取任务，而不是 `Promise.all` 整批 ——
 * 后者在 L2（上万篇）时会把所有请求一次性建起来，直接撞限流。
 */
export async function runDownloads(opts: RunOptions): Promise<RunResult> {
  const { paths, fetchText, remoteShaOf, accept, onProgress, shouldStop } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY);

  const ok: string[] = [];
  const failed: string[] = [];
  let bytes = 0;
  let done = 0;
  let cursor = 0;
  let stopped = false;

  const report = (): void => {
    onProgress?.({ done, total: paths.length, ok: ok.length, failed: failed.length, bytes });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      if (shouldStop?.()) {
        stopped = true;
        return;
      }
      const index = cursor++;
      const path = paths[index];
      if (path === undefined) return;

      const sha = remoteShaOf(path);
      if (!sha) {
        failed.push(path);
        done++;
        report();
        continue;
      }
      try {
        const text = await fetchText(sha);
        // 字节数按 UTF-8 算：中文笔记的字符数会明显小于实际下载量，用字符数会低估
        const size = new TextEncoder().encode(text).byteLength;
        const accepted = await accept(path, text, sha);
        if (accepted) {
          ok.push(path);
          bytes += size;
        } else {
          // sha 对不上：内容被截断或串了，宁可不写盘
          failed.push(path);
        }
      } catch {
        failed.push(path);
      }
      done++;
      report();
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, paths.length); i++) workers.push(worker());
  await Promise.all(workers);

  report();
  return { ok, failed, bytes, stopped };
}
