/**
 * 磁盘版 `FileStore`：给**本地脚本**用的（端到端自测、将来做桌面调试也用得上）。
 *
 * 为什么必须有它：端到端如果用内存文件层，**每次跑都是全新的本地状态**，于是应用会
 * 老老实实把最近一批笔记重新下载一遍 —— 一次几百个请求。而真实使用里，第二次同步
 * 只会补差量。用内存层测端到端，既慢又白白消耗配额，还不像真实场景。
 *
 * 这里刻意不做任何"聪明"的事：不缓存、不批量、路径原样拼。它是测试替身，
 * 越是直白越不容易掩盖真实实现里的问题。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileStore, FsEntry } from './store';

export class NodeFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private abs(name: string): string {
    return join(this.root, name);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async ensureDir(dir: string): Promise<void> {
    await mkdir(this.abs(dir), { recursive: true });
  }

  async readText(name: string): Promise<string | null> {
    const bytes = await this.readBytes(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async readBytes(name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.abs(name)));
    } catch {
      return null;
    }
  }

  async writeText(name: string, content: string): Promise<void> {
    await this.writeBytes(name, new TextEncoder().encode(content));
  }

  async writeBytes(name: string, bytes: Uint8Array): Promise<void> {
    const path = this.abs(name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async remove(name: string): Promise<void> {
    await rm(this.abs(name), { force: true, recursive: true });
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.abs(name));
      return true;
    } catch {
      return false;
    }
  }

  async list(dir: string): Promise<FsEntry[]> {
    const abs = this.abs(dir);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      return [];
    }
    const out: FsEntry[] = [];
    for (const name of names) {
      const s = await stat(join(abs, name));
      // 只列文件：同步只关心笔记，子目录不进清单
      if (!s.isFile()) continue;
      out.push({ name, mtime: Math.floor(s.mtimeMs), size: s.size });
    }
    return out;
  }
}
