/**
 * 清单与三方判定的单测。
 *
 * 覆盖每一种"本地 vs 基准 / 远端 vs 基准"的组合，以及清单的序列化往返。
 */
import { describe, expect, it } from 'vitest';
import {
  FLAG,
  type Meta,
  type NoteEntry,
  MetaFormatError,
  deserializeMeta,
  diffWithRemote,
  emptyMeta,
  effectiveMtime,
  hasRealMtime,
  isDirty,
  isMetadataOnly,
  serializeMeta,
  summarize,
} from './manifest';

function note(path: string, localSha: string, remoteSha: string, syncedSha: string, extra: Partial<NoteEntry> = {}): NoteEntry {
  return { path, localSha, remoteSha, syncedSha, size: 10, mtime: 1, fileMtime: 0, flags: 0, ...extra };
}

function metaWith(notes: NoteEntry[]): Meta {
  const m = emptyMeta('owner/repo');
  for (const n of notes) m.notes[n.path] = n;
  return m;
}

describe('diffWithRemote 三方判定', () => {
  it('两侧都没变 → skip', () => {
    const meta = metaWith([note('a.md', 'S', 'S', 'S')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'S', size: 10 }]);
    expect(d.changes).toEqual([{ kind: 'skip', path: 'a.md' }]);
  });

  it('只有远端变了 → take-remote', () => {
    const meta = metaWith([note('a.md', 'S', 'S', 'S')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'R', size: 20 }]);
    expect(d.changes).toEqual([{ kind: 'take-remote', path: 'a.md' }]);
  });

  it('只有本地变了 → push-local', () => {
    const meta = metaWith([note('a.md', 'L', 'S', 'S')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'S', size: 10 }]);
    expect(d.changes).toEqual([{ kind: 'push-local', path: 'a.md' }]);
  });

  it('两侧都变了 → conflict', () => {
    const meta = metaWith([note('a.md', 'L', 'S', 'S')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'R', size: 20 }]);
    expect(d.changes).toEqual([{ kind: 'conflict', path: 'a.md' }]);
  });

  it('远端新增 → pull-new，并记入 addedRemotely', () => {
    const d = diffWithRemote(emptyMeta(), [{ path: '新笔记.md', sha: 'R', size: 5 }]);
    expect(d.changes).toEqual([{ kind: 'pull-new', path: '新笔记.md' }]);
    expect(d.addedRemotely).toEqual(['新笔记.md']);
  });

  it('本地新文件（远端没有、清单也没有）→ unpushed', () => {
    const d = diffWithRemote(emptyMeta(), [], ['新建的.md']);
    expect(d.unpushed).toEqual(['新建的.md']);
    expect(d.changes).toEqual([]);
  });

  it('本地新文件但远端恰好同名同内容 → 认账，不重复推', () => {
    // 清单条目存在、localSha 与远端一致（例如推送成功但记账丢失）
    const meta = metaWith([note('a.md', 'S', '', '')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'S', size: 10 }], ['a.md']);
    expect(d.changes).toEqual([{ kind: 'skip', path: 'a.md' }]);
    expect(d.unpushed).toEqual([]);
  });

  it('本地新文件 + 远端同名但内容不同 → conflict（没有共同基准）', () => {
    const meta = metaWith([note('a.md', 'L', '', '')]);
    const d = diffWithRemote(meta, [{ path: 'a.md', sha: 'R', size: 10 }], ['a.md']);
    expect(d.changes).toEqual([{ kind: 'conflict', path: 'a.md' }]);
    expect(d.unpushed).toEqual([]);
  });

  it('远端删除且本地没动 → deletedLocally（跟着删）', () => {
    const meta = metaWith([note('a.md', 'S', 'S', 'S')]);
    const d = diffWithRemote(meta, []);
    expect(d.deletedLocally).toEqual(['a.md']);
    expect(d.keepDeletedLocally).toEqual([]);
  });

  it('远端删除但本地动过 → keepDeletedLocally（保留本地）', () => {
    const meta = metaWith([note('a.md', 'L', 'S', 'S')]);
    const d = diffWithRemote(meta, []);
    expect(d.keepDeletedLocally).toEqual(['a.md']);
    expect(d.deletedLocally).toEqual([]);
  });

  it('未同步过的空壳条目被丢弃（既不推也不删）', () => {
    const meta = metaWith([note('空的.md', '', '', '')]);
    const d = diffWithRemote(meta, []);
    expect(d.unpushed).toEqual([]);
    expect(d.deletedLocally).toEqual([]);
    expect(d.keepDeletedLocally).toEqual([]);
  });

  it('混合场景：一次同步里的全部类别', () => {
    const meta = metaWith([
      note('skip.md', 'S1', 'S1', 'S1'),
      note('remote.md', 'S2', 'S2', 'S2'),
      note('local.md', 'L3', 'S3', 'S3'),
      note('both.md', 'L4', 'S4', 'S4'),
      note('gone.md', 'S5', 'S5', 'S5'),
      note('kept.md', 'L6', 'S6', 'S6'),
    ]);
    const remote = [
      { path: 'skip.md', sha: 'S1', size: 1 },
      { path: 'remote.md', sha: 'R2', size: 1 },
      { path: 'local.md', sha: 'S3', size: 1 },
      { path: 'both.md', sha: 'R4', size: 1 },
      { path: '全新.md', sha: 'R7', size: 1 },
    ];
    const d = diffWithRemote(meta, remote, ['本地新建.md']);
    const byPath = Object.fromEntries(d.changes.map((c) => [c.path, c.kind]));
    expect(byPath).toEqual({
      'skip.md': 'skip',
      'remote.md': 'take-remote',
      'local.md': 'push-local',
      'both.md': 'conflict',
      '全新.md': 'pull-new',
    });
    expect(d.deletedLocally).toEqual(['gone.md']);
    expect(d.keepDeletedLocally).toEqual(['kept.md']);
    expect(d.unpushed).toEqual(['本地新建.md']);
    expect(summarize(d)).toEqual({ toPull: 2, toPush: 2, conflicts: 1, toDelete: 1, keptLocal: 1, unchanged: 1 });
  });
});

describe('清单序列化', () => {
  it('往返一致（含 0 空串等默认值）', () => {
    const meta = metaWith([
      note('a.md', 'L', 'R', 'S', { size: 123, mtime: 1700000000000, flags: FLAG.DIRTY | FLAG.CONFLICT }),
      note('b.md', '', '', '', { size: 0, mtime: 0, flags: FLAG.METADATA_ONLY }),
    ]);
    meta.lastCommit = 'c0ffee';
    meta.lastTree = 'tree1';
    meta.conflicts = ['a.md'];
    meta.lastSyncAt = 1700000000001;

    const round = deserializeMeta(serializeMeta(meta));
    expect(round).toEqual(meta);
  });

  it('墓碑的远端 sha 要能存盘再读回来（否则删除根本推不动）', () => {
    // 这条是整个删除链路的地基：墓碑必须自带"远端那一版是什么"，而它**只能**靠落盘留住 ——
    // 删除动作已经把 notes 里那条移走了，重启之后再没有别处能查到它。
    // 丢了 sha 的症状是静默的：推送时判不出远端有没有这条，删除什么都不做，还不报错。
    const meta: Meta = {
      ...emptyMeta(),
      removed: [{ path: '删掉的.md', remoteSha: 'sha-远端那一版' }],
    };
    expect(deserializeMeta(serializeMeta(meta)).removed).toEqual([
      { path: '删掉的.md', remoteSha: 'sha-远端那一版' },
    ]);
  });

  it('老清单的纯路径墓碑照旧读得进来（sha 留空，但绝不能丢记录）', () => {
    // 老格式是字符串数组。读进来 sha 是空的，那种墓碑推不动删除，
    // 但**丢掉它更糟** —— 它是"本地删过"的唯一证据。
    const raw = JSON.stringify({ v: 1, removed: ['老的.md'], notes: {} });
    expect(deserializeMeta(raw).removed).toEqual([{ path: '老的.md', remoteSha: '' }]);
  });

  it('混着老格式与新格式也能读（升级途中不会丢一半）', () => {
    const raw = JSON.stringify({ v: 1, removed: ['老的.md', ['新的.md', 'sha-新']], notes: {} });
    expect(deserializeMeta(raw).removed).toEqual([
      { path: '老的.md', remoteSha: '' },
      { path: '新的.md', remoteSha: 'sha-新' },
    ]);
  });

  it('缺字段时给出安全默认值（不抛异常）', () => {
    const m = deserializeMeta(JSON.stringify({ v: 1, notes: { 'a.md': ['L'] } }));
    expect(m.notes['a.md']).toEqual({
      path: 'a.md',
      localSha: 'L',
      remoteSha: '',
      syncedSha: '',
      size: 0,
      mtime: 0,
      fileMtime: 0,
      flags: 0,
    });
    expect(m.branch).toBe('master');
    expect(m.histFrontier).toBe('');
  });

  it('老清单（没有 fileMtime 那一项）照样读得出来，时间如实为空', () => {
    // 关键：新版在元组末尾**追加**了一项，老清单少一项不能变成"清单损坏"，
    // 也不能默认成某个真时间（那等于界面显示一个编出来的日期）
    const old = JSON.stringify({ v: 1, notes: { 'a.md': ['L', 'R', 'S', 10, 1700000000000, 0] } });
    const e = deserializeMeta(old).notes['a.md']!;
    expect(e.mtime).toBe(1700000000000);
    expect(e.fileMtime).toBe(0);
    expect(hasRealMtime(e)).toBe(false);
    // 显示/排序要退回 mtime，不能变成 0（0 会让它排到最后）
    expect(effectiveMtime(e)).toBe(1700000000000);
  });

  it('版本不符与损坏内容都报明确错误', () => {
    expect(() => deserializeMeta('{"v":99}')).toThrow(MetaFormatError);
    expect(() => deserializeMeta('不是 json')).toThrow(MetaFormatError);
    expect(() => deserializeMeta('null')).toThrow(MetaFormatError);
  });

  it('数组式编码不会比对象式更大（真实规模下显著更小）', () => {
    // 注意：压缩收益来自"省掉每个条目重复出现的键名"，条目越多越明显；
    // 单条样本上两者几乎持平，所以这里只断言"不更大"。
    const realSha = 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0';
    const meta = metaWith([
      note('读书笔记.md', realSha, realSha, realSha, { size: 4096, mtime: 1700000000000 }),
      note('会议记录 2026-09-12.md', realSha, realSha, realSha, { size: 2048, mtime: 1700000000001 }),
    ]);
    const compact = serializeMeta(meta);
    const verbose = JSON.stringify(meta);
    expect(compact.length).toBeLessThanOrEqual(verbose.length);
  });
});

describe('状态位', () => {
  it('isDirty / isMetadataOnly', () => {
    expect(isDirty(note('a.md', '', '', '', { flags: FLAG.DIRTY }))).toBe(true);
    expect(isDirty(note('a.md', '', '', '', { flags: FLAG.METADATA_ONLY }))).toBe(false);
    expect(isMetadataOnly(note('a.md', '', '', '', { flags: FLAG.METADATA_ONLY }))).toBe(true);
    expect(isMetadataOnly(note('a.md', '', '', '', { flags: 0 }))).toBe(false);
  });
});

describe('删除要在清单里留墓碑（否则永远传不到远端）', () => {
  it('清单里记着"本地删过"、远端还在 → 判为待删除', () => {
    const meta: Meta = { ...emptyMeta(), removed: [{ path: '删掉的.md', remoteSha: 'sha-删掉的' }] };
    const d = diffWithRemote(meta, [{ path: '删掉的.md', sha: 'R', size: 5 }]);
    expect(d.removedLocally).toEqual(['删掉的.md']);
    // 关键：它**不能**被当成"远端新增、没见过"，那样会被重新拉回来，删除等于没做
    expect(d.addedRemotely).toEqual([]);
  });

  it('远端已经没有它了 → 墓碑不用再提（已经一致）', () => {
    const meta: Meta = { ...emptyMeta(), removed: [{ path: '删掉的.md', remoteSha: 'sha-删掉的' }] };
    const d = diffWithRemote(meta, []);
    expect(d.removedLocally).toEqual([]);
  });

  it('摘要里删除数把墓碑算进去（界面显示的数量要和实际动作一致）', () => {
    const meta: Meta = { ...emptyMeta(), removed: [{ path: '删掉的.md', remoteSha: 'sha-删掉的' }] };
    const d = diffWithRemote(meta, [{ path: '删掉的.md', sha: 'R', size: 5 }]);
    expect(summarize(d).toDelete).toBe(1);
  });

  it('老清单没有这个字段 → 当成空的，不报错', () => {
    const meta = emptyMeta();
    const raw = serializeMeta(meta).replace(',"removed":[]', '');
    expect(deserializeMeta(raw).removed).toEqual([]);
  });
});
