/**
 * Capacitor 文件层：真机实现。
 *
 * 全部落在应用私有目录（`Directory.Data`），**不需要任何存储权限**。
 * Capacitor 的 Filesystem 没有"递归列目录"也没有"建目录"，所以：
 *   * 平铺存储正好只要一次 `readdir`；
 *   * 目录由 `mkdir` 显式创建，父目录由写入时自动带上。
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { FileStore, FsEntry } from './store';

const toBytes = (data: string | Blob): Uint8Array => {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  // Web 实现会返回 Blob；这里同步取不到内容，交由调用方走 readFile 文本路径
  throw new Error('readBytes 仅支持文本或二进制字符串数据');
};

const fromBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export class CapacitorFileStore implements FileStore {
  async init(): Promise<void> {
    for (const dir of ['notes', 'trash', 'state']) {
      try {
        await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
      } catch {
        // 已存在即可
      }
    }
  }

  async ensureDir(dir: string): Promise<void> {
    try {
      await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    } catch {
      // 已存在即可
    }
  }

  async readText(name: string): Promise<string | null> {
    try {
      const res = await Filesystem.readFile({ path: name, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof res.data === 'string' ? res.data : null;
    } catch {
      return null; // 不存在与读失败一律当"没有"，由上层决定降级
    }
  }

  async readBytes(name: string): Promise<Uint8Array | null> {
    try {
      const res = await Filesystem.readFile({ path: name, directory: Directory.Data });
      if (typeof res.data === 'string') return fromBase64(res.data);
      return toBytes(res.data);
    } catch {
      return null;
    }
  }

  async writeText(name: string, content: string): Promise<void> {
    await Filesystem.writeFile({ path: name, directory: Directory.Data, data: content, encoding: Encoding.UTF8, recursive: true });
  }

  async writeBytes(name: string, bytes: Uint8Array): Promise<void> {
    await Filesystem.writeFile({ path: name, directory: Directory.Data, data: toBase64(bytes), recursive: true });
  }

  async remove(name: string): Promise<void> {
    try {
      await Filesystem.deleteFile({ path: name, directory: Directory.Data });
    } catch {
      // 不存在不算错
    }
  }

  async list(dir: string): Promise<FsEntry[]> {
    try {
      const res = await Filesystem.readdir({ path: dir, directory: Directory.Data });
      return res.files.map((f) => ({
        name: f.name,
        size: typeof f.size === 'number' ? f.size : null,
        mtime: typeof f.mtime === 'number' ? f.mtime : null,
      }));
    } catch {
      return []; // 目录不存在 → 空列表
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path: name, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }
}
