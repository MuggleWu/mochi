/**
 * 冲突识别的测试。
 *
 * 这是"拒推"的依据，判错了的后果分两种，都很难自己发现：
 * 判漏了 → 手机会把本地那版推上去，**覆盖电脑上刚写的东西**；
 * 判多了 → 明明没冲突却推不动，用户以为同步坏了。
 *
 * 所以四种组合都要验，而不是只看冲突那一种。
 */
import { describe, expect, it } from 'vitest';
import { conflictsOf, withConflicts } from './conflict';
import { diffWithRemote, emptyMeta, FLAG, type Meta, type NoteEntry } from './manifest';
import { pathsToPush } from './push';

const entry = (over: Partial<NoteEntry> = {}): NoteEntry => ({
  path: '笔记.md',
  localSha: '',
  remoteSha: '',
  syncedSha: '',
  size: 0,
  mtime: 0,
  fileMtime: 0,
  flags: 0,
  ...over,
});

/** 现场：基准是 base1，两侧可以各改成不同的 sha。 */
function metaWith(over: Partial<NoteEntry>): Meta {
  return {
    ...emptyMeta(),
    notes: { '笔记.md': entry(over) },
    lastCommit: 'c0',
    lastTree: 't0',
  };
}

const remoteOf = (meta: Meta) =>
  Object.entries(meta.notes)
    .filter(([, e]) => e.remoteSha)
    .map(([path, e]) => ({ path, sha: e.remoteSha, size: e.size }));

const diffOf = (meta: Meta) => diffWithRemote(meta, remoteOf(meta), Object.keys(meta.notes));

describe('两侧都改过才算冲突', () => {
  it('本地改了、远端也改了 → 冲突', () => {
    const meta = metaWith({ localSha: 'local1', remoteSha: 'remote1', syncedSha: 'base1', flags: FLAG.DIRTY });
    const items = conflictsOf(diffOf(meta), meta);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: '笔记.md', localSha: 'local1', remoteSha: 'remote1', syncedSha: 'base1' });
  });

  it('只有本地改过 → 不是冲突，是待推', () => {
    const meta = metaWith({ localSha: 'local1', remoteSha: 'base1', syncedSha: 'base1', flags: FLAG.DIRTY });
    expect(conflictsOf(diffOf(meta), meta)).toHaveLength(0);
    expect(pathsToPush(diffOf(meta))).toEqual(['笔记.md']);
  });

  it('只有远端改过 → 不是冲突，而是要拉下来覆盖本地', () => {
    const meta = metaWith({ localSha: 'base1', remoteSha: 'remote1', syncedSha: 'base1' });
    const diff = diffOf(meta);
    expect(conflictsOf(diff, meta)).toHaveLength(0);
    // 远端那条要被下载下来（`planDownloads` 按 localSha !== remoteSha 挑），
    // 这正是"回电脑上理顺之后、手机上拉一次覆盖"所依赖的那一步
    expect(diff.changes.some((c) => c.kind === 'take-remote' && c.path === '笔记.md')).toBe(true);
  });

  it('两边都没改 → 什么都不是', () => {
    const meta = metaWith({ localSha: 'base1', remoteSha: 'base1', syncedSha: 'base1' });
    const diff = diffOf(meta);
    expect(conflictsOf(diff, meta)).toHaveLength(0);
    expect(pathsToPush(diff)).toEqual([]);
  });

  it('**冲突的篇目不进待推列表** —— 这是"拒推"之外的第二道保险', () => {
    // 即使推送那边判断失误放行了，这里也不会把它算进要推的集合
    const meta = metaWith({ localSha: 'local1', remoteSha: 'remote1', syncedSha: 'base1', flags: FLAG.DIRTY });
    expect(pathsToPush(diffOf(meta))).toEqual([]);
  });
});

describe('冲突清单的记账', () => {
  it('记进清单、又能清掉', () => {
    const meta = metaWith({ localSha: 'local1', remoteSha: 'remote1', syncedSha: 'base1', flags: FLAG.DIRTY });
    const marked = withConflicts(meta, conflictsOf(diffOf(meta), meta));
    expect(marked.conflicts).toEqual(['笔记.md']);

    // 冲突消失（例如远端已经和本地一致了）后，记账也要跟着清掉
    const settled = metaWith({ localSha: 'base1', remoteSha: 'base1', syncedSha: 'base1' });
    expect(withConflicts(settled, conflictsOf(diffOf(settled), settled)).conflicts).toEqual([]);
  });

  it('多篇冲突时都记上', () => {
    const meta: Meta = {
      ...emptyMeta(),
      notes: {
        '甲.md': entry({ path: '甲.md', localSha: 'l1', remoteSha: 'r1', syncedSha: 'b1' }),
        '乙.md': entry({ path: '乙.md', localSha: 'l2', remoteSha: 'r2', syncedSha: 'b2' }),
      },
    };
    const items = conflictsOf(diffOf(meta), meta);
    expect(items.map((i) => i.path).sort()).toEqual(['甲.md', '乙.md'].sort());
    expect(withConflicts(meta, items).conflicts).toHaveLength(2);
  });
});
