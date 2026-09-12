/**
 * 设置：仓库、分支、访问令牌在**运行时**由用户填写，存在应用私有目录。
 *
 */
import type { FileStore } from '@core/fs/store';
import { META_FILE } from '@core/fs/layout';

export interface Settings {
  repo: string;
  branch: string;
  token: string;
}

export const DEFAULT_SETTINGS: Settings = { repo: '', branch: 'master', token: '' };

interface StoredShape {
  repo?: string;
  branch?: string;
  token?: string;
}

export async function loadSettings(store: FileStore): Promise<Settings> {
  const raw = await store.readText(META_FILE);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const o = JSON.parse(raw) as StoredShape;
    return {
      repo: typeof o.repo === 'string' ? o.repo : '',
      branch: typeof o.branch === 'string' && o.branch ? o.branch : 'master',
      token: typeof o.token === 'string' ? o.token : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(store: FileStore, settings: Settings): Promise<void> {
  await store.writeText(META_FILE, JSON.stringify(settings));
}

/** 是否具备同步条件（缺一不可）。 */
export function isConfigured(s: Settings): boolean {
  return Boolean(s.repo && s.token && s.branch);
}

/** 给界面显示的摘要：只说仓库与分支，不含令牌。 */
export function describeSettings(s: Settings): string {
  if (!isConfigured(s)) return '未配置同步仓库';
  return `${s.repo} · ${s.branch}`;
}
