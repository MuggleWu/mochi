/**
 * 推送：把本地改动推回仓库。
 *
 * 全程不用 `git`，走 Git Data API 的三个请求 —— 建树（带上基准树，只送改动的文件）、
 * 建提交（父提交 = 上次同步的那个）、更新分支。
 *
 * ## 为什么"要推哪些文件"是现成的
 *
 * 三方判定（`manifest.ts` 的 `diffWithRemote`）在拉取阶段已经算好了：`push-local`
 * 是两侧都有、只有本地变了；`push-new` 是本地新增；`unpushed` 是本地新建且远端还没有；
 * `deletedLocally` 是远端已删、本地也没动过 —— 它由**拉取**基于"远端为权威"判出来，
 * 所以这里跟着删是安全的（本地真删过的笔记走的是另一条路：`keepDeletedLocally`）。
 *
 * ## 绝不强推
 *
 * `updateRef` 用 `force: false`。远端在我们读取之后被推过时 GitHub 会拒绝，那时
 * **如实报冲突**让用户先拉取，而不是覆盖别人的改动。
 *
 * ## 为什么推完还要读回校验
 *
 * "请求返回 200"不等于"内容真的换了"。参考拉取侧的教训：下载完要**落盘前校验 sha**，
 * 对不上宁可当失败。推送这里同样不能只看返回值 —— 但也不必把 660 KB 的递归树拉回来
 * 比对（那等于每次推送都抵消掉增量的意义）。
 *
 * 用一条**更便宜也更强**的证明：读回刚建立的那个提交，确认
 *
 * 1. 它的父提交**正是**我们推送前记录的 `lastCommit` —— 中间没有人插进来；
 * 2. 它的树**正是**我们刚建的 `treeSha`。
 *
 * 两点都成立，就意味着"我们发出的那批改动确实落在了一个基于已知状态的新提交上"。
 * 代价是 1 个小请求。
 */

import { blobShaOfText } from '../crypto/sha';
import type { GithubClient, TreeChange } from '../net/github';
import type { DiffResult } from './manifest';

/** 推送结果。 */
export interface PushOutcome {
  /**
   * 成功与否。
   *
   * `false` 只表示"**没有确认成功**"（网络失败、并发推送、校验不符），
   * 而不表示"确定没推上去" —— 提交可能已经建立在远端，只是没能确认。
   * 所以失败时**一律保留脏标记**：下次推送至多推一遍重复内容，绝不会漏推。
   */
  ok: boolean;
  /** 新提交 sha（成功时）。 */
  commit: string;
  /** 新根树 sha（成功时）。 */
  tree: string;
  /** 实际写入远端的路径。 */
  written: string[];
  /** 实际从远端删除的路径。 */
  deleted: string[];
  /** 读回校验通过。 */
  verified: boolean;
  /** 失败原因，给用户看。 */
  error?: string;
}

export interface PushDeps {
  client: GithubClient;
  /** 上次同步记录的提交 sha，作为新提交的父提交与校验基准。 */
  baseCommit: string;
  /** 上次同步记录的根树 sha，作为 `base_tree`（只上传改动的文件）。 */
  baseTree: string;
  /** 三方判定结果。 */
  diff: DiffResult;
  /** 读某个笔记的当前内容；本地没有内容时返回 `null`。 */
  readNote: (path: string) => Promise<string | null>;
  /** 提交消息。 */
  message: string;
  /** 校验用的期望本地 sha（推送前记录的 `localSha`）。 */
  expectedSha: (path: string) => string;
  /**
   * 这个路径是否带着"本地有改动"的标记。
   *
   * 不传就等于全都算脏 —— 只有测试会这么用；生产路径一定传 `meta` 里的真实标记。
   */
  isDirty?: (path: string) => boolean;
}

/**
 * 从三方判定结果里挑出**要推送**的路径（新增 + 本地改动）。
 *
 * `unpushed`（本地有、远端没有、又没有共同基准）里的条目，只有**真的带着"本地改动"
 * 标记**的才推。
 *
 * 这条限制是踩出来的：清单有时是从磁盘重建的（本地是缓存，允许重建），而"上次同步到哪儿了"
 * 这个信息**只存在清单里、磁盘上没有**。重建之后，那些早就同步过、只是被重新读了一遍的笔记
 * 会变成"看起来从没同步过"，于是被当成新笔记推上去 —— 远端凭空多出一批内容相同或还带着
 * 中间状态的笔记。要求脏标记就干净了：没被用户改过的东西，永远不会因为一次重建而被推。
 */
export function pathsToPush(diff: DiffResult, isDirty: (path: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const c of diff.changes) {
    if (c.kind === 'push-local' || c.kind === 'push-new') out.push(c.path);
  }
  for (const path of diff.unpushed) {
    if (isDirty(path)) out.push(path);
  }
  return [...new Set(out)];
}

/**
 * 组装提交消息。
 *
 * 刻意**不写笔记标题**：标题常常就是笔记的全部信息（"某某人的电话"），而这些记录会
 * 长期留在仓库里。只写动作与数量；要看细节，diff 本身就是内容。
 */
export function pushMessage(written: readonly string[], deleted: readonly string[]): string {
  const parts: string[] = [];
  if (written.length) parts.push(`更新 ${written.length} 篇`);
  if (deleted.length) parts.push(`删除 ${deleted.length} 篇`);
  return `mochi：${parts.join('、') || '无改动'}`;
}

/**
 * 读内容时发现文件已经和预期 sha 不符 —— 说明用户在这期间又改了它。
 *
 * **不猜、不重试**：这一篇跳过，其余照推。它的脏标记会被保留（因为我们没把它算进
 * `written`），下次推送自然带上最新的内容。比"用旧内容覆盖"或"整批失败"都好。
 */
export async function pushNotes(deps: PushDeps): Promise<PushOutcome> {
  const fail = (error: string): PushOutcome => ({
    ok: false,
    commit: '',
    tree: '',
    written: [],
    deleted: [],
    verified: false,
    error,
  });

  const targets = pathsToPush(deps.diff, deps.isDirty);
  // 两类删除：远端已删而本地没动过的（跟着删），以及本地删过、远端还没删的（墓碑）
  const deletes = [...new Set([...deps.diff.deletedLocally, ...deps.diff.removedLocally])];
  if (targets.length === 0 && deletes.length === 0) {
    return { ok: true, commit: deps.baseCommit, tree: deps.baseTree, written: [], deleted: [], verified: true };
  }

  const changes: TreeChange[] = [];
  const written: string[] = [];
  for (const path of targets) {
    const content = await deps.readNote(path);
    if (content === null) continue; // 本地没有内容（空壳条目），跳过
    // 内容在这期间又变过 → 不用旧内容覆盖远端，留给下一次推送
    if ((await blobShaOfText(content)) !== deps.expectedSha(path)) continue;
    changes.push({ path, content });
    written.push(path);
  }
  for (const path of deletes) changes.push({ path, delete: true });

  if (written.length === 0 && deletes.length === 0) {
    // 全都在这期间又变过了：什么都没推，也就不该清任何脏标记
    return { ok: true, commit: deps.baseCommit, tree: deps.baseTree, written: [], deleted: [], verified: true };
  }

  let result: { commitSha: string; treeSha: string };
  try {
    result = await deps.client.push({
      baseTree: deps.baseTree,
      parentCommit: deps.baseCommit,
      changes,
      message: deps.message,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // 读回校验：父提交必须是我们推送前记的那个，树必须是我们刚建的。
  try {
    const back = await deps.client.getCommit(result.commitSha);
    if (back.parentSha !== deps.baseCommit) {
      return {
        ok: false,
        commit: result.commitSha,
        tree: result.treeSha,
        written,
        deleted: deletes,
        verified: false,
        error: '远端在我们推送期间被改过，已停下以免覆盖。请先拉取一次再推。',
      };
    }
    if (back.treeSha !== result.treeSha) {
      return {
        ok: false,
        commit: result.commitSha,
        tree: result.treeSha,
        written,
        deleted: deletes,
        verified: false,
        error: '推送后的读回校验不符（树对不上）。请先拉取一次再推。',
      };
    }
  } catch (err) {
    // 校验请求本身失败：提交可能已经上去了，但我们无法确认 → 报失败、保留脏标记
    return fail(`推送已发出但没能确认：${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: true, commit: result.commitSha, tree: result.treeSha, written, deleted: deletes, verified: true };
}
