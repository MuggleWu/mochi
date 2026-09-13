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
  /** 第一个父提交；根提交为空串。 */
  parentSha: string;
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

/** 提交列表里的一条（只要反推修改时间够用的字段）。 */
/**
 * 取单个提交的文件清单时最多翻多少页。
 *
 * 每页 100 条，30 页 = 3000 个文件。正常提交远小于这个量级，留这么大余量只是防御：
 * 万一某次提交异常巨大（例如一次性导入），也不至于无限翻页。
 */
const COMMIT_FILES_MAX_PAGES = 30;

export interface CommitSummary {
  sha: string;
  /** ISO 时间串（committer date）。 */
  date: string;
}

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
  /**
   * 分支头 commit sha。
   *
   * 这个请求的 404 有两种成因，而两者的修法完全不同 —— "分支名写错"要去改分支，
   * "令牌没勾这个仓库"要去改令牌。原始提示只能把两种可能并列出来，用户得自己猜。
   * 这里多做一步判定，把它收敛成确定的结论。
   *
   * 判定靠**两个 404 的差异**：仓库层面读得到 → 仓库名和令牌都没问题，那分支就是错的；
   * 仓库层面也 404 → 才回到"两种可能"。
   *
   * 代价只落在失败路径上：成功时下面的代码根本不执行，只多两个很小的请求
   * （仓库信息 + 分支列表）。**不要**为了省这点代价去掉判定 —— 猜错方向让用户
   * 去重发令牌，比多两个请求糟得多。
   */
  async getRefHead(): Promise<string> {
    let data: { object?: { sha?: string } };
    try {
      data = await this.request<{ object?: { sha?: string } }>(
        `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      );
    } catch (err) {
      if (!(err instanceof GithubError) || err.status !== 404) throw err;
      throw await this.explainRefNotFound(err);
    }
    const sha = data.object?.sha;
    if (!sha) throw new GithubError('bad-response', 200, '分支信息里没有 sha', '确认分支名是否正确。');
    return sha;
  }

  /** 把 getRefHead 的 404 收敛成确定的结论（见那个方法的注释）。 */
  private async explainRefNotFound(original: GithubError): Promise<GithubError> {
    let repoReadable = false;
    let branches: string[] = [];
    try {
      await this.request<{ default_branch?: string }>(`/repos/${this.repo}`);
      repoReadable = true;
    } catch {
      // 读不到 = 仓库名不对或令牌没授权，保持原来那句并列提示
    }
    if (repoReadable) {
      try {
        const refs = await this.request<{ ref?: string }[]>(`/repos/${this.repo}/git/refs/heads`);
        branches = refs.map((r) => (r.ref ?? '').replace(/^refs\/heads\//, '')).filter(Boolean);
      } catch {
        // 拿不到分支列表不影响结论，只是少一句"实际有哪些分支"
      }
    }

    if (!repoReadable) return original;

    // main / master 写反是最常见的，所以把实际存在的分支直接列出来
    const known = branches.slice(0, 8);
    const hint =
      known.length > 0
        ? `这个仓库里没有分支「${this.branch}」，实际有：${known.join('、')}。改成其中之一即可；仓库名和令牌都是好的，不用动它们。`
        : `这个仓库里没有分支「${this.branch}」，改一个实际存在的分支名；仓库名和令牌都是好的，不用动它们。`;
    return new GithubError('not-found', 404, `分支「${this.branch}」不存在`, hint);
  }

  /** commit → 根树 sha。 */
  async getCommit(sha: string): Promise<CommitInfo> {
    const data = await this.request<{
      sha?: string;
      message?: string;
      tree?: { sha?: string };
      parents?: { sha?: string }[];
      commit?: { committer?: { date?: string } };
    }>(`/repos/${this.repo}/git/commits/${sha}`);
    if (!data.tree?.sha) throw new GithubError('bad-response', 200, '提交信息里没有根树', '远端返回的数据不完整，重试一次。');
    return {
      sha: data.sha ?? sha,
      treeSha: data.tree.sha,
      message: data.message ?? '',
      date: data.commit?.committer?.date ?? '',
      // 合并提交有多个父提交，取第一个（反推修改时间只需要"更早的那个点"）
      parentSha: data.parents?.[0]?.sha ?? '',
    };
  }

  /**
   * 列提交（新→旧）。
   *
   * 用来反推"每篇笔记最后一次被改动是什么时候"。GitHub 的 `per_page` 上限就是 100，
   * 传更大也不会多给，所以这里定死，避免调用方误以为能一次拿完。
   */
  async listCommits(page = 1, perPage = 100): Promise<CommitSummary[]> {
    const size = Math.min(100, Math.max(1, perPage));
    const data = await this.request<
      { sha?: string; commit?: { committer?: { date?: string } } }[]
    >(`/repos/${this.repo}/commits?per_page=${size}&page=${Math.max(1, page)}`);
    if (!Array.isArray(data)) return [];
    return data
      .map((c) => ({ sha: c.sha ?? '', date: c.commit?.committer?.date ?? '' }))
      .filter((c) => c.sha !== '');
  }

  /**
   * 某个提交**改动了哪些文件**（取全，自动翻页）。
   *
   * 反推"每篇笔记最后一次被改动的时间"就靠它。
   *
   * **必须翻页**：不带分页参数时，这个接口最多只给 300 个文件，而且**不报错、不提示
   * 被截断**（`files` 就 300 项，看着像"这个提交真的只改了 300 个"）。凡是走过批量
   * 整理或一次性导入的仓库，都会有相当比例的提交正好卡在 300 —— 而漏掉的那部分恰恰是
   * "一篇笔记最后被改动是什么时候"最需要的信息。翻页后能拿到完整的清单。
   *
   * 顺带记一笔：`compare`（区间比较）也有同一个 300 上限，且 `files_truncated`
   * 会谎报 false，所以反推时间没有走那条路。
   *
   * `.files` 里也包含 `.obsidian/`、`.trash/` 这类非笔记文件，过滤交给调用方
   * （它才知道"哪些路径是我们关心的"）。
   */
  async listCommitFiles(sha: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= COMMIT_FILES_MAX_PAGES; page += 1) {
      const data = await this.request<{ files?: { filename?: string }[] }>(
        `/repos/${this.repo}/commits/${sha}?per_page=100&page=${page}`,
      );
      const files = data.files ?? [];
      for (const f of files) {
        if (typeof f.filename === 'string') out.push(f.filename);
      }
      if (files.length < 100) break;
    }
    return out;
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
