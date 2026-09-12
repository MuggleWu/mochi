/**
 * FileStore 的内存实现：单测替身。
 *
 * 刻意保留"桥调用会失败"的可注入能力（`failNextReads`），
 * 用来测试分级拉取的重试与降级路径。
 */
import type { FileStore, FsEntry } from './store';

interface MemFile {
  bytes: Uint8Array;
  mtime: number;
}

export class MemoryFileStore implements FileStore {
  private files = new Map<string, MemFile>();
  /** 让接下来 N 次读取失败（模拟网络/桥异常）。 */
  failNextReads = 0;
  /** 累计的读调用次数（用于断言"没有多余 IO"）。 */
  readCalls = 0;
  private clock = 0;

  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [name, content] of Object.entries(seed)) void this.writeText(name, content);
    }
  }

  async init(): Promise<void> {}

  async ensureDir(_dir: string): Promise<void> {}

  async readText(name: string): Promise<string | null> {
    this.readCalls += 1;
    if (this.failNextReads > 0) {
      this.failNextReads -= 1;
      throw new Error(`注入的读取失败: ${name}`);
    }
    const f = this.files.get(name);
    return f ? new TextDecoder().decode(f.bytes) : null;
  }

  async readBytes(name: string): Promise<Uint8Array | null> {
    this.readCalls += 1;
    if (this.failNextReads > 0) {
      this.failNextReads -= 1;
      throw new Error(`注入的读取失败: ${name}`);
    }
    return this.files.get(name)?.bytes ?? null;
  }

  async writeText(name: string, content: string): Promise<void> {
    await this.writeBytes(name, new TextEncoder().encode(content));
  }

  async writeBytes(name: string, bytes: Uint8Array): Promise<void> {
    this.clock += 1;
    this.files.set(name, { bytes, mtime: this.clock });
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }

  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }

  async list(dir: string): Promise<FsEntry[]> {
    const prefix = dir ? `${dir}/` : '';
    const out: FsEntry[] = [];
    for (const [name, f] of this.files) {
      if (prefix && !name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest.includes('/')) continue; // 只列直接子项
      out.push({ name: rest, size: f.bytes.byteLength, mtime: f.mtime });
    }
    return out;
  }

  /** 测试辅助：直接给某个文件设定修改时间。 */
  setMtime(name: string, mtime: number): void {
    const f = this.files.get(name);
    if (f) f.mtime = mtime;
  }

  /** 测试辅助：当前文件清单快照。 */
  snapshot(): string[] {
    return [...this.files.keys()].sort();
  }
}
