import { describe, expect, it, vi } from 'vitest';
import { listAllCommits, parseIso, planRange, walkHistory, type HistoryCommit } from './mtime';

/**
 * 提交名按编号排。
 *
 * 不能直接 `.sort()`：字典序里 `'C10' < 'C6'`，会让断言以"内容好像不对"的样子失败，
 * 其实只是排序规则不同 —— 这个坑值得单独写一行，别再把时间花在重新读日志上。
 */
const byNum = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1));

/** 造历史：C1 最新 … Cn 最旧，**每一天一个提交**（用真实日期运算，不手拼字符串）。 */
function hist(n: number): HistoryCommit[] {
  // 手拼 `String(28 - i)` 会造出 `2026-01--13` 这种非法日期，
  // 时间解析不出来（返回 0），下面的断言就会以看不懂的方式失败 —— 踩过一次
  // 每天一个提交，**下标越大越旧**（C1 最新）—— 这正是 GitHub 返回的顺序
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    sha: `C${i + 1}`,
    date: new Date(base - i * 86_400_000).toISOString(),
  }));
}

describe('取数范围', () => {
  it('空历史 → 什么都不做', () => {
    expect(planRange([], '')).toEqual({ from: 0, to: 0 });
  });

  it('从没整理过 → 整段历史', () => {
    expect(planRange(hist(10), '')).toEqual({ from: 0, to: 10 });
  });

  it('前沿就是最新提交 → 没有新东西（日常同步的常态）', () => {
    expect(planRange(hist(10), 'C1')).toEqual({ from: 0, to: 0 });
  });

  it('增量只整理前沿之后的那些，一个不漏', () => {
    // 前沿 = C51 在下标 50 → 整理下标 0..50（含前沿自己）＝ C1..C51 共 51 个。
    // 把前沿包含进来是必须的：否则那个提交永远算不到，前沿也无法朝更旧的方向推进
    expect(planRange(hist(100), 'C51')).toEqual({ from: 0, to: 51 });
  });

  it('前沿在中间但历史不完整时，只到最旧那个提交为止（不越界）', () => {
    // 前沿 = C8 在下标 7 → 整理下标 0..7，即 C1..C8
    expect(planRange(hist(10), 'C8')).toEqual({ from: 0, to: 8 });
  });

  it('前沿不在历史里（被 force push / rebase）→ 整段重来', () => {
    expect(planRange(hist(10), '早就没了的提交')).toEqual({ from: 0, to: 10 });
  });

  // 注意：数量封顶不在 planRange 里（见那里的注释），而在 walkHistory 对切片封顶。
  // 下面测的是"范围本身"。
  it('前沿在中间时范围到前沿为止（含）', () => {
    expect(planRange(hist(10), 'C5')).toEqual({ from: 0, to: 5 });
  });

  it('封顶不影响范围本身（它只切本次干多少）', () => {
    expect(planRange(hist(100), '')).toEqual({ from: 0, to: 100 });
  });
});

describe('走历史', () => {
  /** 提交 C_i 改的就是 `C_i.md`。 */
  function fakeDeps(
    commits: HistoryCommit[],
    opts: { frontier?: string; maxCommits?: number; concurrency?: number } = {},
  ) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        frontier: opts.frontier === undefined ? '' : opts.frontier,
        listCommits: vi.fn(async (page: number) => (page === 1 ? commits : [])),
        fetchChanges: vi.fn(async (sha: string) => {
          calls.push(sha);
          return { paths: [`${sha}.md`] };
        }),
        ...(opts.maxCommits ? { maxCommits: opts.maxCommits } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      },
    };
  }

  it('每个文件拿到的是它自己那次提交的时间', async () => {
    const commits = hist(4);
    const { deps, calls } = fakeDeps(commits);
    const res = await walkHistory(deps);

    expect(res.files['C1.md']).toBe(parseIso(commits[0]!.date));
    expect(res.files['C2.md']).toBe(parseIso(commits[1]!.date));
    expect(res.files['C3.md']).toBe(parseIso(commits[2]!.date));
    expect(res.files['C4.md']).toBe(parseIso(commits[3]!.date));
    expect(calls.sort(byNum)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(res.walked).toBe(4);
    expect(res.more).toBe(false);
  });

  it('同一个文件被多个提交改过 → 取最新那次的时间', async () => {
    const commits = hist(3);
    const res = await walkHistory({
      frontier: '',
      listCommits: async (page) => (page === 1 ? commits : []),
      // 三个提交都改了同一个文件
      fetchChanges: async () => ({ paths: ['常见.md'] }),
    });
    // 三个提交都改过它 → 取**最新那次**，也就是下标 0 那个提交（C1）的时间。
    // 注意 hist() 里日期随下标递增而变旧，所以最新的时间是最小的那个数值
    expect(res.files['常见.md']).toBe(parseIso(commits[0]!.date));
    expect(parseIso(commits[0]!.date)).toBeGreaterThan(parseIso(commits[2]!.date));
  });

  it('前沿之前的（更旧的）提交一个都不重问', async () => {
    const commits = hist(10);
    // 前沿 = C5，说明"从最新到 C5"这一段都整理过了（前沿含自身）
    const { deps, calls } = fakeDeps(commits, { frontier: 'C5' });
    const res = await walkHistory(deps);
    // 不封顶时，接着往旧走的就是 C6..C10
    expect(calls.sort(byNum)).toEqual(['C6', 'C7', 'C8', 'C9', 'C10']);
    expect(calls).not.toContain('C5'); // 前沿自己也不重问
    expect(res.walked).toBe(5);
    expect(res.frontier).toBe('C10');
    expect(res.more).toBe(false);
  });

  it('前沿就是最新提交 → 一个请求都不发', async () => {
    const { deps } = fakeDeps(hist(10), { frontier: 'C1' });
    const res = await walkHistory(deps);
    expect(deps.fetchChanges).not.toHaveBeenCalled();
    expect(res.walked).toBe(0);
    expect(res.more).toBe(false);
  });

  it('中断后可续传：前沿记在最旧那个已整理的提交上', async () => {
    const commits = hist(10);
    const { deps } = fakeDeps(commits, { maxCommits: 4 });
    const res = await walkHistory(deps);
    // 只走了最新的 4 个（C1..C4），前沿落在最旧的 C4
    expect(res.frontier).toBe('C4');
    expect(res.walked).toBe(4);
    expect(res.more).toBe(true); // 还有更旧的没整理
    expect(Object.keys(res.files)).toHaveLength(4);
  });

  it('续传只朝更旧的方向推进，两批之间不重不漏', async () => {
    const commits = hist(10);
    // 第一批：最新的 3 个（C1..C3），前沿推进到 C3
    const { deps: d1, calls: c1 } = fakeDeps(commits, { maxCommits: 3 });
    const first = await walkHistory(d1);
    expect(c1.sort()).toEqual(['C1', 'C2', 'C3']);
    expect(first.frontier).toBe(commits[2]!.sha);
    expect(first.more).toBe(true);

    // 第二批：带着第一批的结果与前沿接着走，问的是更旧的那 3 个（C4..C6）
    const { deps: d2, calls: c2 } = fakeDeps(commits, { frontier: first.frontier, maxCommits: 3 });
    const second = await walkHistory({ ...d2, existing: first.files });
    expect(c2.sort()).toEqual(['C4', 'C5', 'C6']); // 没有回头重算
    // 第一批已经算出来的时间**不能被冲掉**
    for (const [path, t] of Object.entries(first.files)) {
      expect(second.files[path]).toBe(t);
    }
    expect(second.walked).toBe(3);
  });

  it('多轮续传合起来等于一趟走完（不漏不错）', async () => {
    const commits = hist(10);
    const one = await walkHistory(fakeDeps(commits).deps);

    // 每轮最多走 3 个提交；前沿一轮一轮朝更旧推进，直到走完
    const rounds: number[] = [];
    let files: Record<string, number> = {};
    let frontier = '';
    for (let round = 0; round < 6; round += 1) {
      const d = fakeDeps(commits, { frontier, maxCommits: 3 }).deps;
      const r = await walkHistory({ ...d, existing: files });
      files = { ...files, ...r.files };
      frontier = r.frontier;
      rounds.push(r.walked);
      if (!r.more) break;
    }

    expect(rounds.slice(0, 3)).toEqual([3, 3, 3]); // 每轮都真的干了活
    expect(files).toEqual(one.files); // 合起来与一趟走完完全一致
    expect(frontier).toBe(commits[9]!.sha); // 前沿推进到最旧那个提交
  });

  it('只保留关心的路径（历史里早删掉的文件不占清单体积）', async () => {
    const commits = hist(4);
    const { deps } = fakeDeps(commits);
    const res = await walkHistory({ ...deps, keepOnly: new Set(['C1.md', 'C3.md']) });
    expect(Object.keys(res.files).sort(byNum)).toEqual(['C1.md', 'C3.md']);
  });

  it('时间解不出来的提交不写假值', async () => {
    const res = await walkHistory({
      frontier: '',
      listCommits: async (page) => (page === 1 ? [{ sha: 'C1', date: '不是时间' }] : []),
      fetchChanges: async () => ({ paths: ['甲.md'] }),
    });
    // 时间是 0 表示"不知道"，合并时会跳过它（不会显示成一个 1970 年的日期）
    expect(res.files['甲.md'] ?? 0).toBe(0);
  });

  it('进度回调走完全程（界面据此显示进度）', async () => {
    const commits = hist(5);
    const { deps } = fakeDeps(commits, { concurrency: 2 });
    const seen: number[] = [];
    const res = await walkHistory({ ...deps, onProgress: (done) => seen.push(done) });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(res.walked).toBe(5);
  });

  it('中途落盘：给的是累计结果（覆盖即可，不用自己合并）', async () => {
    const commits = hist(45); // 每 20 个落一次盘 → 20、40、45（收尾再落一次）
    const { deps } = fakeDeps(commits, { concurrency: 3 });
    const snaps: number[] = [];
    await walkHistory({ ...deps, onPartial: (f) => snaps.push(Object.keys(f).length) });
    expect(snaps.length).toBe(3); // 20、40、收尾
    expect(snaps[snaps.length - 1]).toBe(45); // 最后一份是完整的
    for (let i = 1; i < snaps.length; i += 1) {
      expect(snaps[i]!).toBeGreaterThanOrEqual(snaps[i - 1]!);
    }
  });

  it('并发受控：同时最多只有 n 个请求在飞', async () => {
    const commits = hist(20);
    let inflight = 0;
    let peak = 0;
    await walkHistory({
      frontier: '',
      concurrency: 3,
      listCommits: async (page) => (page === 1 ? commits : []),
      fetchChanges: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 1));
        inflight -= 1;
        return { paths: [] };
      },
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // 确实并发了
  });

  it('空历史不发请求（新仓库）', async () => {
    const { deps } = fakeDeps([]);
    const res = await walkHistory(deps);
    expect(deps.fetchChanges).not.toHaveBeenCalled();
    expect(res.walked).toBe(0);
    expect(res.files).toEqual({});
  });
});

describe('列提交（分页）', () => {
  it('满 100 条才翻下一页，不满就停', async () => {
    const page1 = hist(100);
    const page2 = [{ sha: 'C101', date: '2020-01-01T00:00:00Z' }];
    const listCommits = vi.fn(async (page: number) => (page === 1 ? page1 : page === 2 ? page2 : []));
    const all = await listAllCommits(listCommits);
    expect(all).toHaveLength(101);
    expect(listCommits).toHaveBeenCalledTimes(2);
  });

  it('不满一页就停，不多发请求', async () => {
    const listCommits = vi.fn(async () => hist(30));
    expect(await listAllCommits(listCommits)).toHaveLength(30);
    expect(listCommits).toHaveBeenCalledTimes(1);
  });
});

describe('时间解析', () => {
  it('ISO 串转毫秒', () => {
    expect(parseIso('2026-09-13T04:42:43Z')).toBe(Date.parse('2026-09-13T04:42:43Z'));
  });

  it('解不出来返回 0（不编一个假时间出来）', () => {
    expect(parseIso('')).toBe(0);
    expect(parseIso('随便什么')).toBe(0);
  });
});
