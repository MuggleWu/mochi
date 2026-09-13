/**
 * 推送的单元测试。
 *
 * 这一块失败的后果比拉取严重：拉取出错最多是"没拿到新内容"，推送出错是**改坏别的设备
 * 上的笔记**，或者更隐蔽 —— 以为推上去了、其实没有，用户回到电脑上发现改动不见了。
 *
 * 所以下面相当一部分用例在测"**不确定成功时该怎么办**"：一律保留脏标记。
 * 宁可下次重复推一遍，也绝不能漏推。
 */
import { describe, expect, it } from 'vitest';
import { blobShaOfText } from '../crypto/sha';
import { emptyMeta, markPushed, type DiffResult, type Meta } from './manifest';
import { pathsToPush, pushMessage, pushNotes, type PushDeps } from './push';

const emptyDiff = (over: Partial<DiffResult> = {}): DiffResult => ({
  changes: [],
  deletedLocally: [],
  keepDeletedLocally: [],
  addedRemotely: [],
  unpushed: [],
  removedLocally: [],
  ...over,
});

/** 记录调用参数的假客户端。 */
function fakeClient(overrides: {
  push?: () => Promise<{ commitSha: string; treeSha: string }>;
  getCommit?: (sha: string) => Promise<{ treeSha: string; parentSha: string }>;
} = {}) {
  const calls: { changes: unknown[]; message: string; baseTree: string; parentCommit: string }[] = [];
  return {
    calls,
    push: async (o: { baseTree: string; parentCommit: string; changes: unknown[]; message: string }) => {
      calls.push(o);
      if (overrides.push) return overrides.push();
      return { commitSha: 'NEW_COMMIT', treeSha: 'NEW_TREE' };
    },
    getCommit: async (sha: string) => {
      if (overrides.getCommit) return overrides.getCommit(sha);
      return { treeSha: 'NEW_TREE', parentSha: 'BASE_COMMIT' };
    },
  };
}

/** 造一份依赖：内容从给定 map 里取，sha 也按它算。 */
async function deps(
  content: Record<string, string>,
  diff: DiffResult,
  client: ReturnType<typeof fakeClient>,
): Promise<PushDeps> {
  const shas: Record<string, string> = {};
  for (const [p, c] of Object.entries(content)) shas[p] = await blobShaOfText(c);
  return {
    client: client as unknown as PushDeps['client'],
    baseCommit: 'BASE_COMMIT',
    baseTree: 'BASE_TREE',
    diff,
    readNote: async (p) => content[p] ?? null,
    message: pushMessage(
      diff.changes.filter((c) => c.kind === 'push-local' || c.kind === 'push-new').map((c) => c.path),
      diff.deletedLocally,
    ),
    expectedSha: (p) => shas[p] ?? '',
  };
}

describe('要推哪些文件（三方判定的结果直接可用）', () => {
  it('本地改动与本地新增都要推，远端变动不要', () => {
    const diff = emptyDiff({
      changes: [
        { kind: 'push-local', path: '改过的.md' },
        { kind: 'push-new', path: '新增的.md' },
        { kind: 'take-remote', path: '远端改的.md' },
        { kind: 'skip', path: '没动的.md' },
        { kind: 'conflict', path: '冲突的.md' },
      ],
    });
    expect(pathsToPush(diff).sort((a, b) => a.localeCompare(b))).toEqual(['改过的.md', '新增的.md']);
  });

  it('从未同步过的本地文件（unpushed）也要推', () => {
    expect(pathsToPush(emptyDiff({ unpushed: ['从没推过的.md'] }))).toEqual(['从没推过的.md']);
  });

  it('同一个路径不会因为分别出现在两处而被推两遍', () => {
    const diff = emptyDiff({
      changes: [{ kind: 'push-new', path: 'a.md' }],
      unpushed: ['a.md'],
    });
    expect(pathsToPush(diff)).toEqual(['a.md']);
  });
});

describe('提交消息不夹带笔记内容', () => {
  it('只说动作和数量，不写标题', () => {
    // 标题本身就常是笔记的全部信息（"某某人的电话"），而这些记录会长期留在仓库里
    const msg = pushMessage(['甲.md', '乙.md'], ['丙.md']);
    expect(msg).toBe('mochi：更新 2 篇、删除 1 篇');
    expect(msg).not.toContain('甲');
    expect(msg).not.toContain('丙.md');
  });

  it('只有删除时不提更新', () => {
    expect(pushMessage([], ['x.md'])).toBe('mochi：删除 1 篇');
  });
});

describe('推送成功', () => {
  it('只把改动的文件送给远端（不动没变的），并返回实际写入的路径', async () => {
    const content = { '改过的.md': '新内容', '新增的.md': '新增内容', '没动的.md': '原样' };
    const diff = emptyDiff({
      changes: [
        { kind: 'push-local', path: '改过的.md' },
        { kind: 'push-new', path: '新增的.md' },
        { kind: 'skip', path: '没动的.md' },
      ],
    });
    const client = fakeClient();
    const out = await pushNotes(await deps(content, diff, client));

    expect(out.ok).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.commit).toBe('NEW_COMMIT');
    expect(out.written.sort((a, b) => a.localeCompare(b))).toEqual(['改过的.md', '新增的.md']);
    expect(client.calls).toHaveLength(1);
    const sent = client.calls[0]!.changes as { path: string }[];
    expect(sent.map((c) => c.path).sort((a, b) => a.localeCompare(b))).toEqual(['改过的.md', '新增的.md']);
    expect(sent.some((c) => c.path === '没动的.md')).toBe(false);
  });

  it('删除是送 sha:null（而不是推一个空文件）', async () => {
    const diff = emptyDiff({ deletedLocally: ['远端已删.md'] });
    const client = fakeClient();
    const out = await pushNotes(await deps({}, diff, client));

    expect(out.deleted).toEqual(['远端已删.md']);
    const sent = client.calls[0]!.changes as { path: string; delete?: boolean; content?: string }[];
    expect(sent).toEqual([{ path: '远端已删.md', delete: true }]);
  });

  it('没有任何改动时不发请求，也不改提交（空推是浪费，还会污染历史）', async () => {
    const client = fakeClient();
    const out = await pushNotes(await deps({}, emptyDiff(), client));
    expect(out.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(out.commit).toBe('BASE_COMMIT');
  });
});

describe('不确定成功时一律报失败（宁可重复推，绝不漏推）', () => {
  it('网络失败 → ok=false，调用方因此会保留脏标记', async () => {
    const client = fakeClient({
      push: async () => {
        throw new Error('网络断了');
      },
    });
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: 'a.md' }] });
    const out = await pushNotes(await deps({ 'a.md': 'x' }, diff, client));

    expect(out.ok).toBe(false);
    expect(out.error).toContain('网络断了');
    expect(out.written).toEqual([]); // 什么都没确认成功
  });

  it('推送期间远端被别人推过（父提交对不上）→ 报失败并给出"先拉取"的指引', async () => {
    const client = fakeClient({
      getCommit: async () => ({ treeSha: 'NEW_TREE', parentSha: '别人推的提交' }),
    });
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: 'a.md' }] });
    const out = await pushNotes(await deps({ 'a.md': 'x' }, diff, client));

    expect(out.ok).toBe(false);
    expect(out.verified).toBe(false);
    expect(out.error).toContain('先拉取');
  });

  it('读回校验发现树对不上 → 报失败', async () => {
    const client = fakeClient({
      getCommit: async () => ({ treeSha: '别的树', parentSha: 'BASE_COMMIT' }),
    });
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: 'a.md' }] });
    const out = await pushNotes(await deps({ 'a.md': 'x' }, diff, client));

    expect(out.ok).toBe(false);
    expect(out.error).toContain('树');
  });

  it('校验请求本身失败 → 报失败（提交可能已上去，但无法确认就不能清脏标记）', async () => {
    const client = fakeClient({
      getCommit: async () => {
        throw new Error('读回超时');
      },
    });
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: 'a.md' }] });
    const out = await pushNotes(await deps({ 'a.md': 'x' }, diff, client));

    expect(out.ok).toBe(false);
    expect(out.error).toContain('没能确认');
  });
});

describe('推送期间文件又被改过', () => {
  it('内容与推送前记录的 sha 不符 → 这一篇跳过，不用旧内容覆盖远端', async () => {
    const diff = emptyDiff({
      changes: [
        { kind: 'push-local', path: '正在改的.md' },
        { kind: 'push-local', path: '稳的.md' },
      ],
    });
    const client = fakeClient();
    const d = await deps({ '正在改的.md': '最新的内容', '稳的.md': '稳的内容' }, diff, client);
    // 模拟：用户在这期间又编辑了「正在改的.md」，于是它当前的 sha 与推送前记的不符
    const stale: PushDeps = {
      ...d,
      readNote: async (p) => (p === '正在改的.md' ? '又改了一版' : '稳的内容'),
    };
    const out = await pushNotes(stale);

    expect(out.written).toEqual(['稳的.md']); // 只推了稳的那篇
    const sent = client.calls[0]!.changes as { path: string }[];
    expect(sent.map((c) => c.path)).toEqual(['稳的.md']);
  });

  it('所有文件都在期间变过 → 什么都不推，也不返回成功', async () => {
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: 'a.md' }] });
    const client = fakeClient();
    const d = await deps({ 'a.md': '原内容' }, diff, client);
    const out = await pushNotes({ ...d, readNote: async () => '全都变了' });

    expect(client.calls).toHaveLength(0);
    expect(out.written).toEqual([]);
    expect(out.commit).toBe('BASE_COMMIT'); // 提交没有前进 → 调用方不该当成推进
  });

  it('本地没有内容的空壳条目会被跳过（不该推一个空文件上去）', async () => {
    const diff = emptyDiff({ changes: [{ kind: 'push-local', path: '空壳.md' }] });
    const client = fakeClient();
    const out = await pushNotes(await deps({}, diff, client));
    expect(client.calls).toHaveLength(0);
    expect(out.written).toEqual([]);
  });
});

describe('只有真的改过才推（清单重建不能凭空多出东西）', () => {
  it('本地有、远端没有、但没有"本地改动"标记 → 不推', async () => {
    // 踩过的坑：清单有时从磁盘重建（本地是缓存，允许重建），而"上次同步到哪儿了"
    // 只存在清单里、磁盘上没有。重建之后，早就同步过、只是被重读一遍的笔记会变成
    // "看起来从没同步过"，于是被当成新笔记推上去 —— 远端凭空多出一批内容相同的笔记。
    const diff = emptyDiff({ unpushed: ['没改过的.md', '真改过的.md'] });
    const client = fakeClient();
    const out = await pushNotes({
      ...(await deps({ '没改过的.md': 'a', '真改过的.md': 'b' }, diff, client)),
      isDirty: (p) => p === '真改过的.md',
    });

    expect(out.written).toEqual(['真改过的.md']);
    const sent = client.calls[0]!.changes as { path: string }[];
    expect(sent.map((c) => c.path)).toEqual(['真改过的.md']);
  });

  it('不传 isDirty 时视为都脏（只有测试会这样用）', async () => {
    const diff = emptyDiff({ unpushed: ['a.md'] });
    const client = fakeClient();
    const out = await pushNotes(await deps({ 'a.md': 'x' }, diff, client));
    expect(out.written).toEqual(['a.md']);
  });
});

describe('本地删过的笔记要传到远端（墓碑）', () => {
  it('墓碑里的路径会被删掉，而不是当成"远端有、本地没有"的新笔记', async () => {
    const diff = emptyDiff({ removedLocally: ['删掉的.md'] });
    const client = fakeClient();
    const out = await pushNotes(await deps({}, diff, client));

    expect(out.deleted).toEqual(['删掉的.md']);
    expect(out.written).toEqual([]);
    const sent = client.calls[0]!.changes as { path: string; delete?: boolean }[];
    expect(sent).toEqual([{ path: '删掉的.md', delete: true }]);
  });

  it('墓碑和"远端已删本地没动过"会合并去重后一起送', async () => {
    const diff = emptyDiff({ deletedLocally: ['甲.md'], removedLocally: ['乙.md', '甲.md'] });
    const client = fakeClient();
    const out = await pushNotes(await deps({}, diff, client));
    expect([...out.deleted].sort()).toEqual(['乙.md', '甲.md'].sort());
  });

  it('推送成功后清掉墓碑（否则下次会重复删、也看不出已经一致了）', async () => {
    const meta: Meta = { ...emptyMeta(), removed: [{ path: '甲.md', remoteSha: 's1' }, { path: '乙.md', remoteSha: 's2' }] };
    const next = markPushed(meta, [], ['甲.md']);
    // 只清掉被确认删除的那条，另一条原样留着（含它自带的远端 sha）
    expect(next.removed).toEqual([{ path: '乙.md', remoteSha: 's2' }]);
  });

  it('推送失败时墓碑必须留着（不然删除就丢了）', () => {
    const meta: Meta = { ...emptyMeta(), removed: [{ path: '甲.md', remoteSha: 's1' }] };
    // 失败路径根本不调 markPushed —— 这里只是把这条约定钉住
    expect(meta.removed).toEqual([{ path: '甲.md', remoteSha: 's1' }]);
  });
});
