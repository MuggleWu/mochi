/**
 * 设置：仓库、分支、访问令牌在**运行时**由用户填写，存在应用私有目录。
 *
 * 令牌只落在这个私有文件里，不写日志、不进错误信息。
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
      // 也归一：文件可能被手改过，或来自还没做归一的老版本
      repo: typeof o.repo === 'string' ? normalizeRepo(o.repo) : '',
      branch: typeof o.branch === 'string' && o.branch ? o.branch : 'master',
      token: typeof o.token === 'string' ? o.token : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(store: FileStore, settings: Settings): Promise<void> {
  // 落盘前归一：磁盘上永远只有 `owner/name` 一种形状，下游不必各自兼容
  const normalized: Settings = { ...settings, repo: normalizeRepo(settings.repo) };
  await store.writeText(META_FILE, JSON.stringify(normalized));
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

/**
 * 把用户粘进来的仓库写法归一到 `owner/name`。
 *
 * 为什么必须做：用户在笔记里存的是完整 URL（`https://github.com/owner/repo.git`），
 * 直接复制粘贴是**最自然的操作**。而 `owner/name` 会被原样拼进 API 路径，
 * 于是 `https://github.com/owner/repo` 会被拼成
 * `/repos/https://github.com/owner/repo/git/ref/...` → 404，
 * 而 404 的提示里同时列了"名字写错"和"令牌没授权"两种可能，用户会往错的方向查。
 *
 * 解析不出来时**原样返回**（只做 trim），让网络层去报 404 并给出那两种可能。
 * 不在这里抛错：输入永远不该让界面崩，而且"原样送出去再报错"比"猜一个拼错的地址"更好排查。
 */
export function normalizeRepo(raw: string): string {
  const text = raw.trim().replace(/[\s#?].*$/, ''); // 去掉尾部空白、锚点、查询串
  if (!text) return '';

  // 完整 URL（带协议）或裸域名：去掉协议与主机名，只留路径
  const withoutHost = text.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?github\.com\//i, '');
  const path = withoutHost.replace(/^\/+/, '').replace(/\/+$/, ''); // 去掉首尾斜杠（大小写交给 GitHub 自己判）

  // 取前两段：多余的部分是网页深链接（/tree/main/xxx、/blob/…），不是仓库名的一部分
  const parts = path.split('/');
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  if (!owner || !name) return text;
  return `${owner}/${name.replace(/\.git$/i, '')}`;
}
