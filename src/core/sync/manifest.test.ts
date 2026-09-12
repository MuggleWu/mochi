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
  isDirty,
  isMetadataOnly,
  serializeMeta,
  summarize,
} from './manifest';

function note(path: string, localSha: string, remoteSha: string, syncedSha: string, extra: Partial<NoteEntry> = {}): NoteEntry {
  return { path, localSha, remoteSha, syncedSha, size: 10, mtime: 1, flags: 0, ...extra };
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

  it('缺字段时给出安全默认值（不抛异常）', () => {
    const m = deserializeMeta(JSON.stringify({ v: 1, notes: { 'a.md': ['L'] } }));
    expect(m.notes['a.md']).toEqual({ path: 'a.md', localSha: 'L', remoteSha: '', syncedSha: '', size: 0, mtime: 0, flags: 0 });
    expect(m.branch).toBe('master');
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
