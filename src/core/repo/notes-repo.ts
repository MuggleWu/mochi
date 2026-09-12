/**
 * 笔记仓库：本地文件的读写与 sha 记账。
 *
 * 铁律（性能设计的核心）：
 *   * **只有"打开某篇/保存某篇"才碰文件**；列表、搜索、排序、同步都不读文件；
 *   * 本地 sha 在**落盘那一刻**算一次，之后只在被编辑时重算，不扫全库；
 *   * 删除是软删除（移入 trash），推送成功后才可以清。
 */
import type { FileStore, FsEntry } from '../fs/store';
import { NOTES_DIR, TRASH_DIR, trashFile, noteFile } from '../fs/layout';
import { blobShaOfText } from '../crypto/sha';
import { FLAG, type Meta, type NoteEntry } from '../sync/manifest';
import { displayTitle, isNoteName, sanitizeNoteName, titleFromContent, uniqueNoteName } from '../paths';

export interface OpenedNote {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

export interface BuiltManifest {
  notes: Record<string, NoteEntry>;
  /** 磁盘上多出来的文件（清单里没有）。 */
  added: string[];
  /** 清单里有、磁盘上没有的文件。 */
  removed: string[];
}

function nowStamp(seq: number): number {
  return Date.now() + seq;
}

export class NotesRepo {
  private seq = 0;

  constructor(private readonly store: FileStore) {}

  async init(): Promise<void> {
    await this.store.ensureDir(NOTES_DIR);
    await this.store.ensureDir(TRASH_DIR);
  }

  /** 磁盘上现有的笔记名（一次 readdir，不读任何文件内容）。 */
  async listNames(): Promise<FsEntry[]> {
    const entries = await this.store.list(NOTES_DIR);
    return entries.filter((e) => isNoteName(e.name));
  }

  /** 打开一篇：这是少数会真正读文件的路径。 */
  async open(path: string): Promise<OpenedNote | null> {
    const text = await this.store.readText(noteFile(path));
    if (text === null) return null;
    const entries = await this.store.list(NOTES_DIR);
    const found = entries.find((e) => e.name === path);
    return {
      path,
      content: text,
      size: found?.size ?? new TextEncoder().encode(text).byteLength,
      mtime: found?.mtime ?? nowStamp(this.seq++),
    };
  }

  /** 保存一篇：写文件 + 算 sha，返回更新后的条目。 */
  async save(path: string, content: string): Promise<NoteEntry> {
    await this.store.writeText(noteFile(path), content);
    const sha = await blobShaOfText(content);
    return {
      path,
      localSha: sha,
      remoteSha: '',
      syncedSha: '',
      size: new TextEncoder().encode(content).byteLength,
      mtime: nowStamp(this.seq++),
      flags: FLAG.DIRTY,
    };
  }

  /** 新建：标题取自正文首行；重名自动让路（manifest 查表，零 IO）。 */
  async create(meta: Meta, content = ''): Promise<NoteEntry> {
    const desired = sanitizeNoteName(titleFromContent(content));
    const path = uniqueNoteName(desired, (p) => meta.notes[p] !== undefined || this.existsSync.has(p));
    this.existsSync.add(path);
    return this.save(path, content);
  }

  /** 磁盘上已知存在的笔记名（避免"新建时重名"这一瞬间的重复）。 */
  private existsSync = new Set<string>();

  async rename(from: string, to: string): Promise<{ from: string; to: string; entry: NoteEntry }> {
    const opened = await this.open(from);
    if (!opened) throw new Error(`笔记不存在：${from}`);
    const entry = await this.save(to, opened.content);
    await this.store.remove(noteFile(from));
    return { from, to, entry };
  }

  /**
   * 软删除：移入 trash（保留内容以便同步失败时恢复）。
   * 真正的物理清理发生在推送成功之后。
   */
  async remove(path: string): Promise<void> {
    const opened = await this.open(path);
    if (opened) await this.store.writeText(trashFile(path), opened.content);
    await this.store.remove(noteFile(path));
  }

  /** 从 trash 恢复（推送失败或用户后悔）。 */
  async restore(path: string): Promise<boolean> {
    const text = await this.store.readText(trashFile(path));
    if (text === null) return false;
    await this.store.writeText(noteFile(path), text);
    await this.store.remove(trashFile(path));
    return true;
  }

  /** 清空某个 trash 条目（推送成功后调用）。 */
  async dropTrash(path: string): Promise<void> {
    await this.store.remove(trashFile(path));
  }

  /**
   * 用磁盘现状重建清单。
   *
   * 只在"首次同步"或"清单丢失"时调用：需要读全部文件算 sha。
   * sha 未变化的文件会沿用旧条目，避免全量读盘。
   */
  async buildManifest(previousNotes: Record<string, NoteEntry> = {}, onProgress?: (done: number, total: number) => void): Promise<BuiltManifest> {
    const entries = (await this.listNames()).sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
    const notes: Record<string, NoteEntry> = {};
    const added: string[] = [];
    let done = 0;

    for (const e of entries) {
      const prev = previousNotes[e.name];
      // 上传时间没变且已有本地 sha → 不必读文件重算
      const reusable = prev && prev.localSha && prev.mtime === (e.mtime ?? 0) && prev.size === (e.size ?? prev.size);
      if (reusable) {
        notes[e.name] = { ...prev, path: e.name };
      } else {
        const text = (await this.store.readText(noteFile(e.name))) ?? '';
        const sha = await blobShaOfText(text);
        notes[e.name] = {
          path: e.name,
          localSha: sha,
          remoteSha: prev?.remoteSha ?? '',
          syncedSha: prev?.syncedSha ?? '',
          size: e.size ?? new TextEncoder().encode(text).byteLength,
          mtime: e.mtime ?? nowStamp(this.seq++),
          flags: prev ? prev.flags & ~FLAG.METADATA_ONLY : FLAG.DIRTY,
        };
        if (!prev) added.push(e.name);
      }
      done += 1;
      onProgress?.(done, entries.length);
    }

    const present = new Set(entries.map((e) => e.name));
    const removed = Object.keys(previousNotes).filter((p) => !present.has(p));
    return { notes, added, removed };
  }

  /** 展示用标题（去掉 .md）。 */
  title(path: string): string {
    return displayTitle(path);
  }
}
