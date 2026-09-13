/**
 * 从版本历史反推"每篇笔记最后一次被改动的时间"。
 *
 * 为什么需要：git 的树里**只有内容**，没有文件修改时间。所以应用原先只能拿"下载落盘
 * 那一刻"顶上，导致抽屉排序是"下载顺序"、列表日期是假的。真实修改时间只能从历史里反推。
 *
 * ## 为什么逐个提交取，而不是用区间比较
 *
 * 本来想用区间比较（`compare`）把一段连续的提交合并成一次请求，但**不可行**：
 *
 * - 区间返回的文件是**整个区间的并集**，接口不告诉你每个文件属于哪个提交；
 * - 更要命的是它有 **300 条的静默上限**：一段 50 个提交本来改了约 1900 个文件，
 *   只回 300 个，而且 `files_truncated` 还报 `false`（谎报）。
 *   所以覆盖率很低，而且同段内的文件会共用同一个时间 → 排序等于假的。
 * - 顺带一提，这么问还很慢（单段 20~30 秒）。
 *
 * 所以改成**逐个提交**问（`GET /commits/{sha}`）：它给的文件清单是准确的（**但要翻页**，
 * 见 `core/net/github.ts`）。代价是请求数随提交数线性增长，一次全量可能几百个请求、
 * 单路要几十分钟，所以**必须并发**（复用内容下载那套并发），并且**可中断续传**。
 *
 * ## 续传靠"前沿"
 *
 * 整理到哪个提交就记下来。下次列一遍提交（1~5 个请求）就能判断出哪一段还没整理，
 * 已经整理过的一个都不重问 —— 所以日常同步只多 1~2 个请求。
 */

/** 提交列表里的一条。 */
export interface HistoryCommit {
  sha: string;
  /** ISO 时间串。 */
  date: string;
}

export interface WalkDeps {
  /** 列提交，`page` 从 1 开始，返回新→旧的顺序。 */
  listCommits: (page: number) => Promise<HistoryCommit[]>;
  /** 取某个提交改动的文件。 */
  fetchChanges: (sha: string) => Promise<{ paths: string[] }>;
  /** 上次整理到的提交。空串 = 从没整理过。 */
  frontier: string;
  /**
   * 上次已经算出的映射，续传时接着用。
   *
   * **必须传**，否则续传那一轮会从空映射开始，`onPartial` 落盘时把先前的结果冲掉。
   */
  existing?: Record<string, number>;
  /** 并发数（同时开几个请求）。 */
  concurrency?: number;
  /** 本次最多整理多少个提交（防御用；不传就是全部）。 */
  maxCommits?: number;
  /** 进度回调（已完成提交数 / 本次计划数）。 */
  onProgress?: (done: number, total: number) => void;
  /**
   * 每批完成回调，便于把中间结果落盘（中断了不用从头再来）。
   * 给的是**目前累计**的完整映射，调用方直接覆盖即可。
   */
  onPartial?: (files: Record<string, number>) => void;
  /**
   * 只保留这些路径的时间。
   *
   * 传笔记路径全集：历史里还留着早就删掉的文件（`.trash/` 之类也不少），
   * 那些时间对我们没用，存下来只是白占清单体积。
   */
  keepOnly?: Set<string>;
}

export interface WalkResult {
  /** 路径 → 最后改动时间（毫秒）。 */
  files: Record<string, number>;
  /** 整理到哪个提交（下次接着走）。 */
  frontier: string;
  /** 本次整理了多少个提交。 */
  walked: number;
  /** 是否还有更旧的历史没整理（中断、或达到 maxCommits）。 */
  more: boolean;
}

/** 把 ISO 时间串转毫秒。解不出来返回 0（宁可没有时间，也不要给个假时间）。 */
export function parseIso(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 列表页上限：GitHub 一次最多 100 条，页面多到离谱就停（防御，正常不会触发）。 */
const MAX_PAGES = 100;

/** 把版本历史全部列出来（新→旧）。 */
export async function listAllCommits(listCommits: (page: number) => Promise<HistoryCommit[]>): Promise<HistoryCommit[]> {
  const all: HistoryCommit[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await listCommits(page);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * 算出本次要整理哪一段（`commits` 里的下标区间 `[from, to)`）。
 *
 * 纯函数，便于把最容易错的地方钉死。
 *
 * **前沿的语义是"到它为止（含）都已经整理过了"**（它就是上一次整理到的最旧那个提交）。
 * 所以这里是 `to = 前沿下标 + 1`，必须把前沿本身包进来。
 *
 * 踩过的坑：漏掉这个 `+1` 会两边都错 —— 前沿那个提交永远算不到；而且从"已整理段的最旧
 * 一个"推导出"下一次的范围"时范围反而变小，前沿一次只前进一两个提交，来回蹭。
 * 实测表现是一趟能走完的历史，分轮却永远走不完。
 *
 * 注意这里**不做数量封顶**：封顶要砍的是"更旧的那一头"，而那一头正是下一轮要走的，
 * 砍了就等于原地打转。要限制单次工作量，应该在 `walkHistory` 里对切片封顶（见那里）。
 */
export function planRange(commits: HistoryCommit[], frontier: string): { from: number; to: number } {
  if (commits.length === 0) return { from: 0, to: 0 };
  // 前沿就是最新提交 → 没有新东西可整理（日常同步的常态）
  if (frontier && commits[0]?.sha === frontier) return { from: 0, to: 0 };

  const at = frontier ? commits.findIndex((c) => c.sha === frontier) : -1;
  // 前沿还在历史里 → 整理"从最新到前沿（含）"这一段；
  // 不在 → 说明历史被重写过（force push / rebase），整段重来
  return { from: 0, to: at >= 0 ? at + 1 : commits.length };
}

/**
 * 定数并发地跑（保持"同时最多 n 个在飞"）。
 *
 * 为什么不用 `Promise.all(items.map(...))`：那样会把几百个请求一次性全发出去，
 * 既容易被限流，失败时也分不清进度。这里固定并发数，进度是连续的。
 */
async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.floor(limit));
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * 走一遍历史，得到"路径 → 最后改动时间"。
 *
 * 幂等：同一段历史走第二遍不改变结果（每个路径取的是最大值）。
 * 可中断：`onPartial` 一批一批把结果交出来，落盘后下次从前沿接着走。
 */
export async function walkHistory(deps: WalkDeps): Promise<WalkResult> {
  const commits = await listAllCommits(deps.listCommits);
  // 从上次的结果接着算（续传）；同一路径取更大的时间，所以重算也不会变坏
  const files: Record<string, number> = { ...deps.existing };
  if (commits.length === 0) {
    return { files, frontier: deps.frontier, walked: 0, more: false };
  }

  const { from, to } = planRange(commits, deps.frontier);
  // `to <= from` = 前沿就是最新提交（没有新提交可整理，日常同步的常态）
  if (to <= from) {
    return { files, frontier: deps.frontier || (commits[0]?.sha ?? ''), walked: 0, more: false };
  }

  // 从这里开始算"这一次到底走哪些提交"。
  //
  // 前沿只是**分界点**：它（含）往新的方向都整理过了，往旧的方向还没。所以
  //   起点 = 前沿的下一个下标；没有前沿（第一次）就是 0（最新的那个）。
  //   终点 = 一直走到最旧（`cap` 只用来限制单次干多少，不影响方向）。
  //
  // 这段踩过三次坑，都是"起点/终点选错"造成的，表现各不相同、都很难看出来：
  //   · 从 0 起算 → 每轮都只处理最新那几个，前沿一步不前进（死循环）；
  //   · 右端用 `to`（= 前沿位置）→ 前沿之后一个都不走（原地不动）；
  //   · 第一次就按 `长度 - cap` 取 → 取到的是**最旧**那几个，方向反了。
  const capped = Number.isFinite(deps.maxCommits ?? Number.POSITIVE_INFINITY);
  const cap = capped ? Math.max(1, Math.floor(deps.maxCommits ?? 0)) : commits.length;
  const frontierIdx = deps.frontier ? commits.findIndex((c) => c.sha === deps.frontier) : -1;
  const sliceFrom = frontierIdx >= 0 ? frontierIdx + 1 : 0;
  const sliceTo = Math.min(commits.length, sliceFrom + cap);
  const slice = commits.slice(sliceFrom, sliceTo);
  const total = slice.length;
  let done = 0;
  const BATCH = 20; // 每 20 个提交落一次盘：中断最多损失这么一点

  await mapConcurrent(slice, deps.concurrency ?? 6, async (c) => {
    const { paths } = await deps.fetchChanges(c.sha);
    const t = parseIso(c.date);
    for (const p of paths) {
      if (deps.keepOnly && !deps.keepOnly.has(p)) continue;
      // 更新的提交先跑，所以同一路径遇到更大的时间就是更新的那次改动
      if (t > (files[p] ?? 0)) files[p] = t;
    }
    done += 1;
    deps.onProgress?.(done, total);
    if (done % BATCH === 0) deps.onPartial?.(files);
  });

  deps.onPartial?.(files);
  // 前沿 = 本次走到的最旧那个提交（含）。下次从它之后继续往旧走。
  const oldest = slice[slice.length - 1];
  return {
    files,
    frontier: oldest?.sha ?? deps.frontier,
    walked: total,
    more: sliceTo < commits.length,
  };
}
