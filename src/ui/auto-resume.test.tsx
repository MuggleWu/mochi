// @vitest-environment jsdom
/**
 * "额度用完 → 到点自动接着下"的自测。
 *
 * 这条行为最容易出的问题是**自作主张**：用户明明按了暂停，几分钟后它自己又跑起来。
 * 所以除了"确实会续"，更要钉住"不该续的时候绝不续"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { FakeFetch } from '@core/net/fake-fetch';
import { blobShaOfText } from '@core/crypto/sha';
import { useNotes, __awaitContentPullForTest, __nextTimeoutIsAutoResume, __setFetchForTest } from './store';

/** 额度用完时的响应：403 + 剩余 0（重试也没用，客户端应当直接收手）。 */
const quotaResponse = (): Response =>
  new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800), // 半小时后恢复
    },
  });

class QuotaFake extends FakeFetch {
  /** 置真后，所有 blob 请求都回额度用完；置假则正常返回内容。 */
  exhausted = true;

  constructor(entries: Array<Record<string, unknown>>, contents: Map<string, string>) {
    super([
      { match: '/git/ref/heads/master', responses: [{ json: { object: { sha: 'c1' } } }] },
      { match: '/git/commits/c1', responses: [{ json: { sha: 'c1', tree: { sha: 't1' } } }] },
      { match: '/git/trees/t1', responses: [{ json: { sha: 't1', truncated: false, tree: entries } }] },
      {
        match: /\/git\/blobs\/[^/]+$/,
        responses: [{ text: '' }],
        respond: (url: string): Response | undefined => {
          if (this.exhausted) return quotaResponse();
          const sha = url.split('/git/blobs/')[1]?.split('?')[0] ?? '';
          const text = contents.get(sha);
          return text === undefined ? undefined : new Response(text, { status: 200 });
        },
      },
    ]);
  }
}

async function build(): Promise<{ fake: QuotaFake; fs: MemoryFileStore }> {
  const notes = [
    ['甲.md', '甲的内容'],
    ['乙.md', '乙的内容'],
  ] as const;
  // git blob sha 是异步算的，必须 await —— 传 Promise 进去不会报错，但路由永远匹配不上，
  // 表现是"内容一篇都没下来"，很容易误判成逻辑坏了
  const contents = new Map<string, string>();
  const entries: Array<Record<string, unknown>> = [];
  for (const [path, text] of notes) {
    const sha = await blobShaOfText(text);
    contents.set(sha, text);
    entries.push({ path, mode: '100644', type: 'blob', sha, size: text.length });
  }
  const fake = new QuotaFake(entries, contents);
  return { fake, fs: new MemoryFileStore() };
}

const pendingOf = (): number => useNotes.getState().pendingContent;

beforeEach(() => {
  __setFetchForTest(undefined);
  useNotes.setState({ ...useNotes.getState(), error: null, pullStage: '', pullResumeAt: 0, pullPaused: false });
});

afterEach(() => {
  __setFetchForTest(undefined);
});

describe('额度用完后的自动续下', () => {
  it('额度用完 → 排上自动续下，并记下恢复时刻', async () => {
    const { fake, fs } = await build();
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
    // 先拿到清单（清单就位才谈得上"下内容"）。deferContent 把正文下载留给我们自己起，
    // 否则它会自动开跑，断言里就分不清是谁动的。
    await useNotes.getState().pullMetadata({ deferContent: true });
    expect(pendingOf()).toBeGreaterThan(0);

    await useNotes.getState().pullContent();
    const s = useNotes.getState();
    expect(s.pullResumeAt).toBeGreaterThan(Date.now()); // 排在将来
    expect(s.pullPaused).toBe(true);
    expect(s.lastSyncNote).toContain('自动接着下'); // 说清楚"会自己接着下"，而不是含糊的"已暂停"
    expect(pendingOf()).toBeGreaterThan(0); // 确实还有欠账
  });

  it('**到点后会真的接着下**，且这次能下完', async () => {
    const { fake, fs } = await build();
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
    // 先拿到清单（清单就位才谈得上"下内容"）。deferContent 把正文下载留给我们自己起，
    // 否则它会自动开跑，断言里就分不清是谁动的。
    await useNotes.getState().pullMetadata({ deferContent: true });
    expect(pendingOf()).toBeGreaterThan(0);

    await useNotes.getState().pullContent();
    expect(pendingOf()).toBeGreaterThan(0);

    // 模拟"时刻已到"：额度恢复了，正文也能拿到了
    fake.exhausted = false;
    useNotes.setState({ pullResumeAt: Date.now() - 1 });
    useNotes.getState().resumePullIfDue();
    await __awaitContentPullForTest();

    expect(pendingOf()).toBe(0); // 欠账清掉了
    expect(useNotes.getState().lastSyncNote).toContain('内容已就绪');
  });

  it('**用户按了暂停就不该再续**（最要紧的一条）', async () => {
    const { fake, fs } = await build();
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
    // 先拿到清单（清单就位才谈得上"下内容"）。deferContent 把正文下载留给我们自己起，
    // 否则它会自动开跑，断言里就分不清是谁动的。
    await useNotes.getState().pullMetadata({ deferContent: true });
    expect(pendingOf()).toBeGreaterThan(0);

    await useNotes.getState().pullContent();
    expect(useNotes.getState().pullResumeAt).toBeGreaterThan(0);

    useNotes.getState().pauseContent();
    expect(useNotes.getState().pullResumeAt).toBe(0); // 续期被作废

    const before = fake.requests.length;
    fake.exhausted = false;
    // 就算时刻到了，也不该动
    useNotes.getState().resumePullIfDue();
    await __awaitContentPullForTest();
    expect(fake.requests.length).toBe(before);
    expect(pendingOf()).toBeGreaterThan(0);
  });

  it('额度用完但**已经没有欠账**时不排续期（没活干就别排）', async () => {
    const { fake, fs } = await build();
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });

    // 先正常下完
    fake.exhausted = false;
    await useNotes.getState().pullContent();
    expect(pendingOf()).toBe(0);
    expect(useNotes.getState().pullResumeAt).toBe(0);
  });

  it('**定时器回调真的会起一次下载**（不只是记了个时刻）', async () => {
    /*
     * 只断言 `pullResumeAt > 0` 是不够的：那只能证明"记下了时刻"，证明不了"到点会动"。
     * 这里把定时器抓住、手工触发它 —— 比真等半小时可靠，也不会引入假定时器
     * （全局假定时器会连带卡住用例里别的异步等待）。
     */
    const captured: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      // 只截"自动续下"那一个（store 在调用点插了标志），与时长无关
      if (__nextTimeoutIsAutoResume) {
        captured.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    try {
      const { fake, fs } = await build();
      __setFetchForTest(fake.fetch);
      await useNotes.getState().init(fs);
      await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });
      await useNotes.getState().pullMetadata({ deferContent: true });
      await useNotes.getState().pullContent();

      expect(captured).toHaveLength(1); // 排上了一个
      expect(useNotes.getState().pullResumeAt).toBeGreaterThan(0);

      fake.exhausted = false;
      captured[0]!(); // 到点了
      await __awaitContentPullForTest();
      expect(pendingOf()).toBe(0); // 真的把欠账下完了
    } finally {
      spy.mockRestore();
    }
  });

  it('没排续期时，回到前台什么都不做', async () => {
    const { fake, fs } = await build();
    __setFetchForTest(fake.fetch);
    await useNotes.getState().init(fs);
    await useNotes.getState().saveConfig({ repo: 'owner/repo', branch: 'master', token: 'ok' });

    const before = fake.requests.length;
    useNotes.getState().resumePullIfDue();
    await __awaitContentPullForTest();
    expect(fake.requests.length).toBe(before);
  });
});
