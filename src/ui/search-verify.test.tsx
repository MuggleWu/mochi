// @vitest-environment jsdom
/**
 * "搜出一篇根本没有这个词的笔记" —— 展示前核对的端到端自测。
 *
 * 场景来自用户的真实抱怨：搜一个号码，搜出一篇正文里没有这个号码的笔记。这类错误
 * 比"搜不到"糟得多：有标题、有摘要、命中处还画着下划线，**看起来完全像真的**，
 * 用户会以为自己记错了。
 *
 * 这里刻意构造"索引与正文不一致"的状态（正常路径是不会出现的），验证展示前那道
 * 核对能把它拦住。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { createIndex, updateNote } from '@core/search/index';
import { useNotes, __setSearchIndexForTest } from './store';

const base = useNotes.getState();

beforeEach(() => {
  useNotes.setState({ ...base, ready: false, order: [], current: null, content: '', query: '', rows: [], error: null });
});

afterEach(() => {
  __setSearchIndexForTest(null);
  useNotes.setState(base);
});

/** 起一个真的 store，并塞进一份"内容已经过时"的索引。 */
async function withStaleIndex(files: Record<string, string>, stale: Record<string, string>): Promise<void> {
  const seed: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) seed[`notes/${p}`] = c;
  const fs = new MemoryFileStore(seed);
  await useNotes.getState().init(fs);
  const index = createIndex();
  for (const [p, c] of Object.entries(stale)) updateNote(index, { path: p, content: c });
  __setSearchIndexForTest(index);
}

describe('展示前核对：命中的词必须真的在正文里', () => {
  it('索引里留着旧内容、正文已经改了 → 这条不该出现', async () => {
    // 正文里已经把这个号码删掉了，但索引还记着它（模拟增量更新漏摘）
    await withStaleIndex(
      { '甲.md': '这篇现在没有那个号码了' },
      { '甲.md': '以前写过 020-0000-0000 这个号' },
    );
    await useNotes.getState().setSearchQuery('020-0000-0000');
    expect(useNotes.getState().rows.map((r) => r.path)).toEqual([]);
  });

  it('正文里真的有这个词 → 照常出现（不能误杀）', async () => {
    await withStaleIndex(
      { '甲.md': '这篇写着 020-0000-0000 这个号' },
      { '甲.md': '这篇写着 020-0000-0000 这个号' },
    );
    await useNotes.getState().setSearchQuery('020-0000-0000');
    expect(useNotes.getState().rows.map((r) => r.path)).toEqual(['甲.md']);
  });

  it('只剔掉对不上的那篇，对得上的照常列出', async () => {
    await withStaleIndex(
      { '甲.md': '没有这个号码', '乙.md': '有 020-0000-0000 这个号' },
      { '甲.md': '以前有 020-0000-0000', '乙.md': '有 020-0000-0000 这个号' },
    );
    await useNotes.getState().setSearchQuery('020-0000-0000');
    expect(useNotes.getState().rows.map((r) => r.path)).toEqual(['乙.md']);
  });

  it('文件名命中不受核对影响（那是"找那篇叫 X 的笔记"，另当别论）', async () => {
    await withStaleIndex(
      { '020-0000-0000.md': '正文跟号码无关' },
      {},
    );
    await useNotes.getState().setSearchQuery('020-0000-0000');
    expect(useNotes.getState().rows.map((r) => r.path)).toEqual(['020-0000-0000.md']);
  });
});
