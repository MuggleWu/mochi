/**
 * 拉取阶段一：元数据（1~2 个请求）。
 *
 * 只取"分支头 → 提交 → 递归树"，把仓库**根目录**的 markdown 全表拿到手，
 * 就能填充抽屉列表、文件名搜索与排序 —— **一篇内容都不用下载**。
 *
 * 已知限制（诚实记录）：git 树里没有文件修改时间，所以这一阶段清单里的
 * `mtime` 只能先取"上次同步时刻"（保持顺序稳定）。真正有意义的时间要等
 * 内容下载时用本地文件的修改时间。
 */
import type { GithubClient, TreeEntry } from '../net/github';
import { rootMarkdownFiles } from '../net/github';
import { isNoteName } from '../paths';
import { FLAG, type Meta } from './manifest';

export interface RemoteSnapshot {
  commitSha: string;
  treeSha: string;
  /** 根目录 markdown：路径 → blob sha / 大小。 */
  files: Array<{ path: string; sha: string; size: number }>;
}

/** 取远端快照（分支头 → 提交 → 递归树）。 */
export async function fetchSnapshot(client: GithubClient): Promise<RemoteSnapshot> {
  const commitSha = await client.getRefHead();
  const commit = await client.getCommit(commitSha);
  const listing = await client.listTree(commit.treeSha);
  const notes = rootMarkdownFiles(listing.entries, isNoteName);
  return {
    commitSha,
    treeSha: commit.treeSha,
    files: notes.map((e: TreeEntry) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
  };
}

/**
 * 把远端快照并入清单：更新 remoteSha（以及新条目的路径/大小），
 * 并把"仅元数据"标记打在还没有本地内容的条目上。
 */
export function reconcileSnapshot(meta: Meta, snap: RemoteSnapshot, now = Date.now()): Meta {
  const notes = { ...meta.notes };
  const remotePaths = new Set<string>();

  for (const f of snap.files) {
    remotePaths.add(f.path);
    const prev = notes[f.path];
    if (prev) {
      notes[f.path] = { ...prev, remoteSha: f.sha, size: prev.size || f.size };
    } else {
      // 新出现在远端的笔记：只有元数据，内容等分级拉取
      notes[f.path] = {
        path: f.path,
        localSha: '',
        remoteSha: f.sha,
        syncedSha: '',
        size: f.size,
        // 树里没有修改时间，先记"同步时刻"保证顺序稳定
        mtime: now,
        flags: FLAG.METADATA_ONLY,
      };
    }
  }

  // 远端已经没有的笔记：清掉 remoteSha，并把远端已删标记打上
  for (const [path, entry] of Object.entries(notes)) {
    if (remotePaths.has(path)) continue;
    if (!entry.remoteSha) continue;
    notes[path] = { ...entry, remoteSha: '', flags: entry.flags | FLAG.REMOTE_DELETED };
  }

  return {
    ...meta,
    lastCommit: snap.commitSha,
    lastTree: snap.treeSha,
    notes,
    lastSyncAt: now,
  };
}
