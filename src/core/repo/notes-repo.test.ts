import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../fs/memory-fs';
import { NotesRepo } from './notes-repo';
import { FLAG, emptyMeta, serializeMeta, deserializeMeta } from '../sync/manifest';

const setup = async (seed?: Record<string, string>) => {
  const store = new MemoryFileStore(seed);
  const repo = new NotesRepo(store);
  await repo.init();
  return { store, repo };
};

describe('NotesRepo 基本读写', () => {
  it('保存后用 git blob 算法记账 libs，打开能读回', async () => {
    const { repo } = await setup();
    const entry = await repo.save('读书笔记.md', '# 读书笔记\n\n正文');
    expect(entry.flags & FLAG.DIRTY).toBe(FLAG.DIRTY);
    expect(entry.localSha).toHaveLength(40);

    const opened = await repo.open('读书笔记.md');
    expect(opened?.content).toBe('# 读书笔记\n\n正文');
    expect(opened?.size).toBeGreaterThan(0);
  });

  it('打开不存在的笔记返回 null（不抛异常）', async () => {
    const { repo } = await setup();
    expect(await repo.open('没有这篇.md')).toBeNull();
  });

  it('中文与公式内容原样往返，绝不做任何规范化', async () => {
    const { repo } = await setup();
    const weird = '---\ntitle: 测试\n---\n\n$$\\frac{a}{b}$$\n\n| 列 | 值 |\n|---|---|\n| 1 | 2 |\n\n[[链接|别名]]\n';
    await repo.save('结构.md', weird);
    expect((await repo.open('结构.md'))?.content).toBe(weird);
  });
});

describe('NotesRepo 新建', () => {
  it('标题取自正文首行并清洗成合法文件名（全角标点保留）', async () => {
    const { repo } = await setup();
    const meta = emptyMeta();
    const entry = await repo.create(meta, '## 会议记录：周三/评审\n正文');
    // 全角「：」在文件名里合法且用户笔记名确实在用，必须保留；
    // 半角「/」非法，替换为空格
    expect(entry.path).toBe('会议记录：周三 评审.md');
    expect((await repo.open(entry.path))?.content).toContain('评审');
  });

  it('重名自动让路（不覆盖已有笔记）', async () => {
    const { repo } = await setup();
    const meta = emptyMeta();
    const a = await repo.create(meta, '同样的标题');
    meta.notes[a.path] = a;
    const b = await repo.create(meta, '同样的标题');
    expect(b.path).toBe('同样的标题（2）.md');
    meta.notes[b.path] = b;
    const c = await repo.create(meta, '同样的标题');
    expect(c.path).toBe('同样的标题（3）.md');
  });

  it('空正文兜底为「未命名」', async () => {
    const { repo } = await setup();
    const entry = await repo.create(emptyMeta(), '');
    expect(entry.path).toBe('未命名.md');
  });
});

describe('NotesRepo 重命名与删除', () => {
  it('重命名保留内容并删除旧文件', async () => {
    const { repo, store } = await setup();
    await repo.save('旧名.md', '内容');
    const r = await repo.rename('旧名.md', '新名.md');
    expect(r.to).toBe('新名.md');
    expect(await store.exists('notes/旧名.md')).toBe(false);
    expect((await repo.open('新名.md'))?.content).toBe('内容');
  });

  it('重命名不存在的笔记会报错', async () => {
    const { repo } = await setup();
    await expect(repo.rename('没有.md', '新.md')).rejects.toThrow('笔记不存在');
  });

  it('删除是软删除：内容进 trash，可恢复', async () => {
    const { repo, store } = await setup();
    await repo.save('要删的.md', '重要内容');
    await repo.remove('要删的.md');
    expect(await store.exists('notes/要删的.md')).toBe(false);
    expect(await store.readText('trash/要删的.md')).toBe('重要内容');

    expect(await repo.restore('要删的.md')).toBe(true);
    expect((await repo.open('要删的.md'))?.content).toBe('重要内容');
  });

  it('推送成功后清掉 trash 备份', async () => {
    const { repo, store } = await setup();
    await repo.save('a.md', 'x');
    await repo.remove('a.md');
    await repo.dropTrash('a.md');
    expect(await store.exists('trash/a.md')).toBe(false);
    expect(await repo.restore('a.md')).toBe(false);
  });
});

describe('NotesRepo 重建清单', () => {
  it('首次重建：全部标记为待推送，文件名与磁盘一致', async () => {
    const { repo } = await setup();
    await repo.save('a.md', 'A');
    await repo.save('中文 名字.md', 'B');
    let progress = 0;
    const built = await repo.buildManifest({}, () => {
      progress += 1;
    });
    expect(Object.keys(built.notes).sort()).toEqual(['a.md', '中文 名字.md']);
    expect(built.added.sort()).toEqual(['a.md', '中文 名字.md']);
    expect(built.removed).toEqual([]);
    expect(progress).toBe(2);
    expect(built.notes['a.md']!.flags & FLAG.DIRTY).toBe(FLAG.DIRTY);
  });

  it('只重建 sha 有变化的文件（不扫全库）', async () => {
    const { repo, store } = await setup();
    await repo.save('稳定.md', '不动');
    await repo.save('会变.md', '旧内容');

    const first = await repo.buildManifest({});
    const before = store.readCalls;

    // 只改一个文件
    await repo.save('会变.md', '新内容');
    const second = await repo.buildManifest(first.notes);

    // 稳定那篇沿用了旧条目，所以这次读取次数应远小于"全部重读"
    expect(store.readCalls - before).toBeLessThan(4);
    expect(second.notes['稳定.md']!.localSha).toBe(first.notes['稳定.md']!.localSha);
    expect(second.notes['会变.md']!.localSha).not.toBe(first.notes['会变.md']!.localSha);
    expect(second.added).toEqual([]);
  });

  it('磁盘上消失的文件会被记为 removed', async () => {
    const { repo, store } = await setup();
    await repo.save('留着.md', 'x');
    await repo.save('删了.md', 'y');
    const first = await repo.buildManifest({});
    await store.remove('notes/删了.md');
    const second = await repo.buildManifest(first.notes);
    expect(second.removed).toEqual(['删了.md']);
  });

  it('忽略非 markdown 与非法文件名', async () => {
    const { repo, store } = await setup();
    await repo.save('正常.md', 'x');
    await store.writeText('notes/图片.png', 'binary');
    await store.writeText('notes/CON.md', 'windows 保留名');
    const built = await repo.buildManifest({});
    expect(Object.keys(built.notes)).toEqual(['正常.md']);
  });

  it('清单能往返持久化（含仅元数据标记）', async () => {
    const { repo } = await setup();
    await repo.save('a.md', 'A');
    const built = await repo.buildManifest({});
    const meta = emptyMeta('owner/repo');
    meta.notes = built.notes;
    const round = deserializeMeta(serializeMeta(meta));
    expect(round.notes).toEqual(meta.notes);
  });
});
