/**
 * 全文索引的加载 / 构建 / 落盘。
 *
 * 三层职责分得很清：
 * - `index.ts` 是纯数据结构（能在 Node 里跑完整测试）
 * - 这个文件负责"从磁盘来、回磁盘去"，以及**构建策略**
 * - store 只调 `loadIndex` / `indexNote` / `saveIndex`
 *
 * 构建策略上有两个刻意的设计（都来自实测）：
 *
 * 1. **冷启动不阻塞**。索引 1 万篇实测要十几秒，绝不能卡在启动路径上。
 *    所以 `loadIndex` 只做"读文件"，文件不在或版本不符就返回空索引，
 *    由 `buildIndex` 在后台慢慢填 —— 期间文件名搜索仍然可用。
 * 2. **落盘按批，不按篇**。逐篇写会伤闪存，且中断了也只是重下重索引。
 */

import type { FileStore } from '../fs/store';
import { GRAMS_FILE } from '../fs/layout';
import {
  appendNote,
  createIndex,
  deserializeIndex,
  ensureSorted,
  finishBuild,
  needsIndex,
  removeNote,
  serializeIndex,
  updateNote,
  type SearchIndex,
} from './index';

export interface IndexNote {
  path: string;
  content: string;
  sha: string;
  /** 已下载到本地的笔记才建索引；只有元数据的笔记没有内容可索引。 */
  hasContent: boolean;
}

export interface LoadResult {
  index: SearchIndex;
  /** 索引文件是否可用（false = 需要重建）。 */
  loaded: boolean;
  /** 加载耗时（毫秒），用于诊断。 */
  ms: number;
}

/**
 * 读索引。**永远不抛异常**：索引是可重建的缓存，任何损坏都只意味着"重建一次"，
 * 不该让应用起不来。
 */
export async function loadIndex(store: FileStore): Promise<LoadResult> {
  const started = Date.now();
  try {
    const bytes = await store.readBytes(GRAMS_FILE);
    if (!bytes || bytes.length === 0) {
      return { index: createIndex(), loaded: false, ms: Date.now() - started };
    }
    const index = deserializeIndex(bytes);
    return { index, loaded: true, ms: Date.now() - started };
  } catch {
    // 版本不符 / 文件截断 / 魔数不对：一律当"没有索引"，重建即可。
    // 不在这里删除文件：删了就没法诊断"为什么坏了"。
    return { index: createIndex(), loaded: false, ms: Date.now() - started };
  }
}

export async function saveIndex(store: FileStore, index: SearchIndex): Promise<void> {
  await store.writeBytes(GRAMS_FILE, serializeIndex(index));
}

export async function dropIndex(store: FileStore): Promise<void> {
  await store.remove(GRAMS_FILE);
}

/**
 * 把一批已下载内容的笔记灌进索引。
 *
 * 分两批处理，重点是**别反复排序**：
 * - 新笔记走 `appendNote`（无脑追加，快）
 * - 已存在的走 `updateNote`（要摘旧的，必须升序才能二分）
 *
 * 如果边追加边更新，每次更新前都得把全表排一遍 —— 一批里有几篇更新就排几次。
 * 所以先把新增的全部追加完、收口排序一次，再处理更新的。
 *
 * 已索引过同一份内容（sha 相同）的会跳过 —— 这就是增量更新的入口。
 */
export function indexNotes(index: SearchIndex, notes: readonly IndexNote[]): number {
  const fresh: IndexNote[] = [];
  const changed: IndexNote[] = [];
  for (const note of notes) {
    if (!note.hasContent) continue;
    if (!needsIndex(index, note.path, note.sha)) continue;
    if (index.docIdOf.has(note.path)) changed.push(note);
    else fresh.push(note);
  }

  for (const note of fresh) appendNote(index, { path: note.path, content: note.content, sha: note.sha });
  finishBuild(index); // 追加完收口一次，之后 updateNote 的二分才成立

  for (const note of changed) {
    updateNote(index, { path: note.path, content: note.content, sha: note.sha });
  }
  return fresh.length + changed.length;
}

/** 单篇增量（内容拉取、编辑保存、新建走这里）。 */
export function indexOne(index: SearchIndex, note: IndexNote): void {
  if (!note.hasContent) {
    removeNote(index, note.path);
    return;
  }
  updateNote(index, { path: note.path, content: note.content, sha: note.sha });
}

export { ensureSorted };
