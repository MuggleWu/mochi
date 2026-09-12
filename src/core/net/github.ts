/**
 * GitHub Git Data API 客户端。
 *
 * 设计约束：
 *   * **不用 git**（用户明确）：全部走 REST，且只需要 7 个端点；
 *   * fetch 可注入 —— 网络层能在 Node 里用假实现跑完整用例（超时、限流、404 歧义、非快进冲突）；
 *   * 单请求超时 30 秒：手机热点/地铁里偶尔十几秒，但绝不能永久卡住；
 *   * `cache: 'no-store'` —— 真机踩过：WebView 的私有缓存会让推送后的读回拿到旧值；
 *   * 失败必须分类并给"下一步做什么"的中文提示。特别注意 GitHub 对
 *     **"仓库不存在"和"令牌没授权"都返回 404**，提示必须同时说明两种可能。
 */

export const GITHUB_API = 'https://api.github.com';
export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_GET_RETRIES = 2;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FailureKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'not-found'
  | 'forbidden'
  | 'rate-limit'
  | 'conflict'
  | 'server'
  | 'truncated'
  | 'bad-response';

export class GithubError extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly hint: string;

  constructor(kind: FailureKind, status: number, message: string, hint: string) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind;
    this.status = status;
    this.hint = hint;
  }
}

/** 把 HTTP 状态映射成"用户能照着做"的提示。 */
export function explainFailure(status: number, body: string): GithubError {
  const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim();
  if (status === 401) {
    return new GithubError('auth', status, '访问令牌无效或已过期', '到 GitHub 重新生成一个细粒度令牌，只勾选该仓库的 Contents 读写权限。');
  }
  if (status === 404) {
    return new GithubError(
      'not-found',
      status,
      '仓库或分支没找到',
      '两种可能：①仓库名/分支名写错了；②令牌没有勾选这个仓库（没授权的仓库同样返回 404）。请核对仓库名与令牌的仓库范围。',
    );
  }
  if (status === 403) {
    if (/rate limit/i.test(body)) {
      return new GithubError('rate-limit', status, '请求过于频繁，已被限流', '等几分钟再试；日常增量同步本身只需要个位数请求。');
    }
    return new GithubError('forbidden', status, '令牌权限不足', '确认令牌勾选了该仓库的 Contents 读写；组织仓库还需要管理员批准令牌。');
  }
  if (status === 409) {
    return new GithubError('conflict', status, '远端已经被推过，本次推送不是快进', '先在电脑上确认已提交，然后在应用里拉取一次再推送（不会覆盖远端）。');
  }
  if (status === 422) {
    return new GithubError('bad-response', status, '请求内容被拒绝', `GitHub 拒绝了这次请求：${snippet}`);
  }
  if (status >= 500) {
    return new GithubError('server', status, 'GitHub 服务端错误', '稍后重试；若持续失败可查看 GitHub 状态页。');
  }
  return new GithubError('bad-response', status, '请求失败', `HTTP ${status}：${snippet}`);
}

function retryAfterMs(res: Response): number {
  const retry = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0) return Math.min(retry * 1000, 60_000);
  return 3_000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GithubClientOptions {
  token: string;
  repo: string; // owner/name
  branch: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
  timeoutMs?: number;
  /** 重试前的等待（毫秒），测试里注入 0 避免拖慢用例。 */
  backoffMs?: (attempt: number) => number;
  /** 单次等待上限（毫秒）；测试里可设为 0。 */
  maxRetryDelayMs?: number;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface TreeListing {
  entries: TreeEntry[];
  /** GitHub 在超过 10 万条目或 7MB 时会截断；我们只把它当错误处理，不做分页猜测。 */
  truncated: boolean;
  treeSha: string;
  /** 响应带的 ETag，存下来供下次条件请求（树没变时省掉整个下载）。 */
  etag?: string | null;
}

export interface CommitInfo {
  sha: string;
  treeSha: string;
  message: string;
  date: string;
}

export interface TreeChange {
  path: string;
  /** 新内容（UTF-8 文本）。与 `delete` 二选一。 */
  content?: string;
  /** 删除该路径。 */
  delete?: boolean;
}

export interface PushResult {
  commitSha: string;
  treeSha: string;
}

export const MODE_FILE = '100644';

export class GithubClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly maxRetryDelayMs: number;

  constructor(opts: GithubClientOptions) {
    if (!opts.token) throw new Error('缺少访问令牌');
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) throw new Error('仓库名要写成 owner/name');
    this.token = opts.token;
    this.repo = opts.repo;
    this.branch = opts.branch || 'master';
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.apiBase = opts.apiBase ?? GITHUB_API;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(1000 * 2 ** attempt, 8000));
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
  }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** 底层请求：带超时、失败分类、幂等请求的有限重试。 */
  private async request<T>(path: string, init: RequestInit & { raw?: boolean } = {}, retriable = true): Promise<T> {
    return (await this.requestWithMeta<T>(path, init, retriable)).data;
  }

  /**
   * 与 request 相同，但把响应头一并带回来 —— 条件请求（ETag）需要它。
   */
  private async requestWithMeta<T>(
    path: string,
    init: RequestInit & { raw?: boolean } = {},
    retriable = true,
  ): Promise<{ data: T; status: number; etag: string | null }> {
    const url = `${this.apiBase}${path}`;
    let lastError: GithubError | null = null;

    for (let attempt = 0; attempt <= (retriable ? MAX_GET_RETRIES : 0); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: { ...this.headers(init.raw ? 'application/vnd.github.raw' : undefined), ...(init.headers ?? {}) },
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = err instanceof Error && err.name === 'AbortError';
        lastError = new GithubError(
          aborted ? 'timeout' : 'network',
          0,
          aborted ? `请求超过 ${Math.round(this.timeoutMs / 1000)} 秒没有响应` : '网络连接失败',
          '检查手机网络后重试；如果是地铁/弱网，稍后重连通常就好了。',
        );
        if (attempt < (retriable ? MAX_GET_RETRIES : 0)) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      // 304：内容没变。这不是错误 —— 调用方据此跳过整个下载。
      if (res.status === 304) {
        return { data: undefined as T, status: 304, etag: res.headers.get('etag') };
      }

      if (res.ok) {
        const etag = res.headers.get('etag');
        if (init.raw) return { data: (await res.arrayBuffer()) as unknown as T, status: res.status, etag };
        return { data: (await res.json()) as T, status: res.status, etag };
      }

      const body = await res.text().catch(() => '');
      // 限流与 5xx 值得重试（只对幂等请求）
      const retriableStatus = res.status === 403 ? /rate limit/i.test(body) : res.status >= 500;
      lastError = explainFailure(res.status, body);
      if (retriable && retriableStatus && attempt < MAX_GET_RETRIES) {
        const wait = res.status === 403 ? retryAfterMs(res) : this.backoffMs(attempt);
        await sleep(Math.min(wait, this.maxRetryDelayMs));
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new GithubError('bad-response', 0, '请求失败', '未知错误');
  }

  /** 分支头 commit sha。 */
  async getRefHead(): Promise<string> {
    const data = await this.request<{ object?: { sha?: string } }>(
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    const sha = data.object?.sha;
    if (!sha) throw new GithubError('bad-response', 200, '分支信息里没有 sha', '确认分支名是否正确。');
    return sha;
  }

  /** commit → 根树 sha。 */
  async getCommit(sha: string): Promise<CommitInfo> {
    const data = await this.request<{
      sha?: string;
      message?: string;
      tree?: { sha?: string };
      commit?: { committer?: { date?: string } };
    }>(`/repos/${this.repo}/git/commits/${sha}`);
    if (!data.tree?.sha) throw new GithubError('bad-response', 200, '提交信息里没有根树', '远端返回的数据不完整，重试一次。');
    return {
      sha: data.sha ?? sha,
      treeSha: data.tree.sha,
      message: data.message ?? '',
      date: data.commit?.committer?.date ?? '',
    };
  }

  /** 递归列目录（一次请求拿到全部条目）。 */
  async listTree(treeSha: string): Promise<TreeListing> {
    const listing = await this.listTreeConditional(treeSha, null);
    if (!listing) throw new GithubError('bad-response', 304, '树没有变化', '内部错误：不该在无条件请求下收到 304。');
    return listing;
  }

  /**
   * 带 ETag 的递归列目录。
   *
   * 为什么要这个：递归树是同步里最贵的一个请求 —— 实测某个一万篇的仓库
   * 树响应 660 KB，而本机到 GitHub 只有 28 KB/s，**下载要 23 秒**。
   * 带上 If-None-Match 后，树没变时 GitHub 直接回 304、**0 字节、1.1 秒**，
   * 快 20 倍。所以"内容没变就不下载"必须靠它。
   *
   * 返回 null 表示 304（内容没变），调用方应当沿用上次结果。
   */
  async listTreeConditional(treeSha: string, etag: string | null): Promise<TreeListing | null> {
    const headers: Record<string, string> = etag ? { 'If-None-Match': etag } : {};
    const res = await this.requestWithMeta<{ tree?: TreeEntry[]; truncated?: boolean; sha?: string }>(
      `/repos/${this.repo}/git/trees/${treeSha}?recursive=1`,
      { headers },
    );
    if (res.status === 304) return null;
    return {
      entries: res.data.tree ?? [],
      truncated: Boolean(res.data.truncated),
      treeSha: res.data.sha ?? treeSha,
      etag: res.etag,
    };
  }

  /** 读 blob 原始内容（text）。 */
  async readBlobText(sha: string): Promise<string> {
    const buf = await this.request<ArrayBuffer>(`/repos/${this.repo}/git/blobs/${sha}`, { raw: true });
    return new TextDecoder().decode(buf);
  }

  /** 读 blob 原始字节（图片等）。 */
  async readBlobBytes(sha: string): Promise<Uint8Array> {
    const buf = await this.request<ArrayBuffer>(`/repos/${this.repo}/git/blobs/${sha}`, { raw: true });
    return new Uint8Array(buf);
  }

  /**
   * 建树：一次请求携带全部变更。
   * `content` 内联，免掉逐文件创建 blob（写方向的数量级压力就此消失）。
   * 删除用 `sha: null`。
   */
  async createTree(baseTree: string, changes: TreeChange[]): Promise<string> {
    const tree = changes.map((c) => {
      if (c.delete) return { path: c.path, mode: MODE_FILE, type: 'blob', sha: null };
      return { path: c.path, mode: MODE_FILE, type: 'blob', content: c.content ?? '' };
    });
    const data = await this.request<{ sha?: string }>(
      `/repos/${this.repo}/git/trees`,
      { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
      false,
    );
    if (!data.sha) throw new GithubError('bad-response', 200, '建树结果里没有 sha', '重试一次；若持续失败请查看诊断页。');
    return data.sha;
  }

  /** 建提交。 */
  async createCommit(treeSha: string, parentSha: string, message: string): Promise<string> {
    const data = await this.request<{ sha?: string }>(
      `/repos/${this.repo}/git/commits`,
      { method: 'POST', body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }) },
      false,
    );
    if (!data.sha) throw new GithubError('bad-response', 200, '提交结果里没有 sha', '重试一次；若持续失败请查看诊断页。');
    return data.sha;
  }

  /** 更新分支：`force: false` —— 绝不覆盖远端。 */
  async updateRef(commitSha: string): Promise<void> {
    await this.request(
      `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`,
      { method: 'PATCH', body: JSON.stringify({ sha: commitSha, force: false }) },
      false,
    );
  }

  /**
   * 一次完整推送：建树 → 建提交 → 更新分支（3 个请求）。
   * 远端在我们读取之后被推过时，GitHub 会拒绝更新分支（非快进），绝不 force。
   */
  async push(options: {
    baseTree: string;
    parentCommit: string;
    changes: TreeChange[];
    message: string;
  }): Promise<PushResult> {
    const treeSha = await this.createTree(options.baseTree, options.changes);
    const commitSha = await this.createCommit(treeSha, options.parentCommit, options.message);
    await this.updateRef(commitSha);
    return { commitSha, treeSha };
  }
}

/** 从递归树里筛出仓库**根目录**的 markdown。 */
export function rootMarkdownFiles(entries: TreeEntry[], isNote: (name: string) => boolean): TreeEntry[] {
  return entries.filter((e) => {
    if (e.type !== 'blob') return false;
    if (e.path.includes('/')) return false; // 只要根目录
    return isNote(e.path);
  });
}
