/**
 * 文件层契约。
 *
 * 两个实现：
 *   * `capacitor-fs` —— 真机（应用私有目录，零权限）
 *   * `memory-fs`    —— 单测替身（Node 里跑全部纯逻辑用例）
 *
 * 所有上层逻辑（同步、索引、笔记读写）只依赖这个接口，因此
 * **同步协议与索引可以在 Node 里被完整测试，不需要真机**。
 */

/** 一次列目录拿到的条目（对应 Android 上一次 readdir）。 */
export interface FsEntry {
  /** 文件名（平铺，不含任何目录前缀）。 */
  name: string;
  /** 字节大小；拿不到时为 null。 */
  size: number | null;
  /** 修改时间（毫秒时间戳）；拿不到时为 null。 */
  mtime: number | null;
}

export interface FileStore {
  /** 确保工作目录存在（幂等）。 */
  init(): Promise<void>;
  /** 读文本；不存在返回 null（不抛异常）。 */
  readText(name: string): Promise<string | null>;
  /** 读字节；不存在返回 null。 */
  readBytes(name: string): Promise<Uint8Array | null>;
  /** 写文本（覆盖）。 */
  writeText(name: string, content: string): Promise<void>;
  /** 写字节（覆盖）。 */
  writeBytes(name: string, bytes: Uint8Array): Promise<void>;
  /** 删除；不存在不算错。 */
  remove(name: string): Promise<void>;
  /** 列出目录下全部条目（一次调用，平铺）。 */
  list(dir: string): Promise<FsEntry[]>;
  /** 是否存在。 */
  exists(name: string): Promise<boolean>;
  /** 合并目录为一个（`notes/` 下的全部文件）；不存在则创建空目录。 */
  ensureDir(dir: string): Promise<void>;
}

/** 批量读文本：限制并发，避免把 JS↔原生桥打爆（miki 实测约 9ms/次）。 */
export async function readTextsBatched(
  store: FileStore,
  dir: string,
  names: string[],
  concurrency = 16,
  onEach?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let index = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    for (;;) {
      const i = index++;
      const name = names[i];
      if (name === undefined) return;
      const text = await store.readText(`${dir}/${name}`);
      if (text !== null) out.set(name, text);
      done += 1;
      onEach?.(done, names.length);
    }
  });
  await Promise.all(workers);
  return out;
}
