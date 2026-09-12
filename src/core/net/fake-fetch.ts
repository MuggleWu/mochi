/**
 * 假 fetch：记录请求、按路由返回预设响应。
 *
 * 让网络层可以在 Node 里被完整测试（超时、限流重试、404 歧义、非快进冲突）。
 */
export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeRoute {
  /** 匹配条件：方法 + URL 子串（或正则） */
  method?: string;
  match: string | RegExp;
  /** 响应序列；多次命中依次取，用完取最后一个。 */
  responses: Array<{
    status?: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
    /** 抛出异常以模拟网络中断。 */
    throws?: 'abort' | 'network';
    /** 延迟毫秒（模拟超时）。 */
    delayMs?: number;
  }>;
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private counters = new Map<FakeRoute, number>();

  constructor(private routes: FakeRoute[]) {}

  readonly fetch: (input: string, init?: RequestInit) => Promise<Response> = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    this.requests.push({ url: input, method, body, headers });

    const route = this.routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== method) return false;
      return typeof r.match === 'string' ? input.includes(r.match) : r.match.test(input);
    });
    if (!route) return new Response(JSON.stringify({ message: `未预设的路由: ${method} ${input}` }), { status: 599 });

    const used = this.counters.get(route) ?? 0;
    this.counters.set(route, used + 1);
    const spec = route.responses[Math.min(used, route.responses.length - 1)]!;

    const signal = init?.signal ?? null;
    const abortError = (): Error => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      return err;
    };
    // 真实 fetch 会在 signal 中止时抛 AbortError；这里必须照做，否则超时用例测不到东西
    if (spec.delayMs) {
      if (signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, spec.delayMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw abortError();
    if (spec.throws === 'abort') {
      throw abortError();
    }
    if (spec.throws === 'network') throw new TypeError('Failed to fetch');

    const status = spec.status ?? 200;
    const payload = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? '');
    return new Response(payload, { status, headers: spec.headers ?? {} });
  };

  /** 按 URL 子串统计请求次数。 */
  count(match: string): number {
    return this.requests.filter((r) => r.url.includes(match)).length;
  }
}
