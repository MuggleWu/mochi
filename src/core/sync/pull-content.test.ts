/**
 * 内容分级拉取的单测。
 *
 * 这一层能在 Node 里跑完整测试是 core/ 分层的红利（设计文档 §102）：
 * 真机上验证"L1 拉 300 篇"要等网络、要装包，这里几毫秒就能把边界钉住。
 */
import { describe, expect, it } from 'vitest';
import { CONCURRENCY, L1_COUNT, planDownloads, runDownloads } from './pull-content';

const note = (localSha: string, remoteSha: string): { localSha: string; remoteSha: string } => ({
  localSha,
  remoteSha,
});

describe('planDownloads', () => {
  it('只要 localSha 与 remoteSha 不一致就该下（本地没有 / 远端改了都算）', () => {
    const order = ['a.md', 'b.md', 'c.md', 'd.md'];
    const notes = {
      'a.md': note('', 'sha-a'), // 本地没有 → 要下
      'b.md': note('sha-b', 'sha-b'), // 一致 → 跳过
      'c.md': note('old', 'new'), // 远端改过 → 要下
      'd.md': note('sha-d', ''), // 远端没给 sha → 下不了
    };
    const plan = planDownloads({ order, notes });
    expect(plan.paths).toEqual(['a.md', 'c.md']);
    expect(plan.pendingTotal).toBe(2);
  });

  it('保持传入顺序（排序是调用方的事，这里不能乱排）', () => {
    // 注意别把这里读成"首屏一定会挑到最近编辑的笔记"——**不是**。
    // 调用方按 mtime 排，而 mtime 是"下到本机的时刻"；首启时全部条目的 mtime
    // 还都是同一个同步时刻，排了等于没排，于是实际拿到的就是树里的前 300 篇。
    // 这是已知限制，README「时间戳」一节有说明。
    const order = ['甲.md', '乙.md', '丙.md'];
    const notes = { '甲.md': note('', '1'), '乙.md': note('', '2'), '丙.md': note('', '3') };
    expect(planDownloads({ order, notes }).paths).toEqual(['甲.md', '乙.md', '丙.md']);
  });

  it('limit 截断到前 N 篇，但 pendingTotal 报的是全部待下载数', () => {
    const order = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const notes = Object.fromEntries(order.map((p, i) => [p, note('', `sha-${i}`)]));
    const plan = planDownloads({ order, notes, limit: 2 });
    expect(plan.paths).toEqual(['a.md', 'b.md']);
    // 这一点很关键：界面要显示"内容 2/5"，不是"2/2"
    expect(plan.pendingTotal).toBe(5);
  });

  it('L1 默认取 300 篇', () => {
    expect(L1_COUNT).toBe(300);
    const order = Array.from({ length: 500 }, (_, i) => `n${i}.md`);
    const notes = Object.fromEntries(order.map((p, i) => [p, note('', `sha-${i}`)]));
    expect(planDownloads({ order, notes, limit: L1_COUNT }).paths).toHaveLength(300);
  });

  it('skip 里的跳过（同一次运行里失败过的不要反复重试）', () => {
    const order = ['a.md', 'b.md', 'c.md'];
    const notes = { 'a.md': note('', '1'), 'b.md': note('', '2'), 'c.md': note('', '3') };
    const plan = planDownloads({ order, notes, skip: new Set(['b.md']) });
    expect(plan.paths).toEqual(['a.md', 'c.md']);
    expect(plan.pendingTotal).toBe(2);
  });

  it('清单里有名字但查不到条目时跳过，不抛错', () => {
    expect(planDownloads({ order: ['ghost.md'], notes: {} }).paths).toEqual([]);
  });

  it('limit 为 0 时一篇都不下（L2 已完成的边界）', () => {
    const notes = { 'a.md': note('', '1') };
    expect(planDownloads({ order: ['a.md'], notes, limit: 0 }).paths).toEqual([]);
  });
});

describe('runDownloads', () => {
  const makeOpts = (paths: string[], over: Partial<Parameters<typeof runDownloads>[0]> = {}) => ({
    paths,
    fetchText: async (sha: string) => `内容-${sha}`,
    remoteShaOf: (p: string) => `sha-${p}`,
    accept: async () => true,
    ...over,
  });

  it('全部成功：ok 收全、failed 为空、字节数按 UTF-8 算', async () => {
    const res = await runDownloads(makeOpts(['a.md', 'b.md']));
    expect(res.ok.sort()).toEqual(['a.md', 'b.md']);
    expect(res.failed).toEqual([]);
    expect(res.stopped).toBe(false);
    // "内容-sha-a.md" 每篇 11 字节左右，只断言非零即可，精确值随常量变
    expect(res.bytes).toBeGreaterThan(0);
  });

  it('下载抛错时记进 failed，不影响其他篇', async () => {
    const res = await runDownloads(
      makeOpts(['a.md', 'b.md', 'c.md'], {
        fetchText: async (sha: string) => {
          if (sha === 'sha-b.md') throw new Error('网络断了');
          return 'ok';
        },
      }),
    );
    expect(res.ok.sort()).toEqual(['a.md', 'c.md']);
    expect(res.failed).toEqual(['b.md']);
  });

  it('accept 返回 false（内容 sha 与远端不符）按失败处理，不当成成功', async () => {
    const res = await runDownloads(makeOpts(['a.md'], { accept: async () => false }));
    expect(res.ok).toEqual([]);
    expect(res.failed).toEqual(['a.md']);
  });

  it('远端没给 sha 的直接记失败，不去请求', async () => {
    let fetched = 0;
    const res = await runDownloads(
      makeOpts(['a.md'], {
        remoteShaOf: () => undefined,
        fetchText: async () => {
          fetched++;
          return 'x';
        },
      }),
    );
    expect(fetched).toBe(0);
    expect(res.failed).toEqual(['a.md']);
  });

  it('并发不超过设定值（L2 上万篇时不能一口气建满请求）', async () => {
    let live = 0;
    let peak = 0;
    const paths = Array.from({ length: 30 }, (_, i) => `n${i}.md`);
    await runDownloads(
      makeOpts(paths, {
        concurrency: 4,
        fetchText: async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          live--;
          return 'x';
        },
      }),
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // 确实并行，不是退化成串行
  });

  it('默认并发是 6（设计文档定的 4–8 区间）', () => {
    expect(CONCURRENCY).toBe(6);
  });

  it('shouldStop 后停止，已下好的保留，并报 stopped', async () => {
    let count = 0;
    const paths = Array.from({ length: 50 }, (_, i) => `n${i}.md`);
    const res = await runDownloads(
      makeOpts(paths, {
        concurrency: 1, // 串行，让停止点确定
        shouldStop: () => count >= 5,
        fetchText: async () => {
          count++;
          return 'x';
        },
      }),
    );
    expect(res.stopped).toBe(true);
    expect(res.ok.length).toBeLessThan(paths.length);
    expect(res.ok.length).toBeGreaterThan(0);
  });

  it('进度回调能拿到累计的 done/total/ok/failed', async () => {
    const seen: { done: number; total: number; ok: number; failed: number }[] = [];
    await runDownloads(
      makeOpts(['a.md', 'b.md'], {
        concurrency: 1,
        onProgress: (p) => seen.push({ done: p.done, total: p.total, ok: p.ok, failed: p.failed }),
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    expect(last).toEqual({ done: 2, total: 2, ok: 2, failed: 0 });
  });

  it('空任务列表直接返回，不建 worker', async () => {
    const res = await runDownloads(makeOpts([]));
    expect(res).toEqual({ ok: [], failed: [], bytes: 0, stopped: false });
  });
});
