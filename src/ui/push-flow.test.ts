/**
 * 推送编排的测试（store 层，用假网络）。
 *
 * 为什么要有这一层：`push.ts` 的单元测试只覆盖"给定 diff、推送做对了没有"，
 * 而这次真正咬人的 bug 全在**它上游**——推送集合是怎么算出来的。具体是两处：
 *
 * 1. 清单重建后条目的 `remoteSha` 会丢（远端 sha 只存在清单里、磁盘上没有），
 *    于是"远端有没有这条""远端删了没有"全部判不出来；
 * 2. 合并清单和重建结果时，如果让重建结果盖住清单，写出来的代码看起来像"合回来了"，
 *    实际症状和没合一样 —— 必须让**内容以磁盘为准、远端记录以清单为准**。
 *
 * 两处都是静默出错：没有报错、没有异常，只是"点推送没反应"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { blobShaOfText } from '@core/crypto/sha';
import { MANIFEST_FILE } from '@core/fs/layout';
import { emptyMeta, serializeMeta, FLAG, type Meta, type NoteEntry } from '@core/sync/manifest';
import { useNotes, __setFetchForTest } from './store';

const REPO = 'owner/name';
const BRANCH = 'master';
/** 假远端：路径 → 内容。 */
let remote: Record<string, string> = {};
let remoteTreeSha = 'TREE_0';
let remoteRefSha = 'COMMIT_0';
/** 远端提交的父提交（用来验证读回校验）。 */
let remoteParentSha = 'PARENT_0';
let callCount = 0;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 把假远端拼成一份递归树响应。 */
async function treeResponse(): Promise<Response> {
  const tree: { path: string; mode: string; type: string; sha: string; size: number }[] = [];
  for (const [path, content] of Object.entries(remote)) {
    const sha = await blobShaOfText(content);
    tree.push({ path, mode: '100644', type: 'blob', sha, size: content.length });
  }
  return json({ sha: remoteTreeSha, tree, truncated: false });
}

function installFakeFetch(): void {
  __setFetchForTest((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    callCount += 1;
    const method = (init?.method ?? 'GET').toUpperCase();

    // 读取 Blob 内容
    const blob = /\/git\/blobs\/([0-9a-f]+)$/.exec(url);
    if (blob && method === 'GET') {
      for (const content of Object.values(remote)) {
        if ((await blobShaOfText(content)) === blob[1]) {
          return json({ content: btoa(unescape(encodeURIComponent(content))), encoding: 'base64' });
        }
      }
      return new Response('{}', { status: 404 });
    }

    // 分支头
    if (/\/git\/ref\/heads\//.test(url) && method === 'GET') {
      return json({ object: { sha: remoteRefSha } });
    }
    // 建/改引用
    if (/\/git\/refs\/heads\//.test(url) && (method === 'PATCH' || method === 'POST')) {
      return json({ object: { sha: remoteRefSha } });
    }
    // 提交
    if (/\/git\/commits\//.test(url) && method === 'GET') {
      return json({ sha: remoteRefSha, tree: { sha: remoteTreeSha }, parents: [{ sha: remoteParentSha }] });
    }
    if (/\/git\/commits$/.test(url) && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { tree: string; parents: string[] };
      remoteRefSha = `COMMIT_${callCount}`;
      remoteTreeSha = body.tree;
      remoteParentSha = body.parents[0] ?? ''; // 记住父提交，读回校验要查它
      return json({ sha: remoteRefSha, tree: { sha: body.tree } });
    }
    // 建树：假远端按送来的内容更新（删除即移除）
    if (/\/git\/trees$/.test(url) && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        tree: { path: string; content?: string; sha?: null }[];
      };
      for (const c of body.tree) {
        if (c.sha === null) delete remote[c.path];
        else if (c.content !== undefined) remote[c.path] = c.content;
      }
      remoteTreeSha = `TREE_${callCount}`;
      return json({ sha: remoteTreeSha });
    }
    // 列树（提交里带的 tree sha）
    if (/\/git\/trees\//.test(url) && method === 'GET') return treeResponse();
    // 建提交用的 tree
    if (/\/git\/trees$/.test(url) && method === 'GET') return treeResponse();
    throw new Error(`假网络没实现这个请求: ${method} ${url}`);
  }) as typeof fetch);
}

/** 造一份本地状态：磁盘上有哪些笔记、清单里记了什么。 */
async function boot(disk: Record<string, string>, meta: Meta): Promise<MemoryFileStore> {
  const seed: Record<string, string> = {};
  for (const [path, content] of Object.entries(disk)) seed[`notes/${path}`] = content;
  seed[MANIFEST_FILE] = serializeMeta(meta);
  const fs = new MemoryFileStore(seed);
  await useNotes.getState().init(fs);
  await useNotes.getState().saveConfig({ repo: REPO, branch: BRANCH, token: 't' });
  return fs;
}

function entry(path: string, localSha: string, remoteSha: string, syncedSha: string, flags = 0): NoteEntry {
  return { path, localSha, remoteSha, syncedSha, size: 0, mtime: 1, fileMtime: 0, flags };
}

beforeEach(() => {
  remote = {};
  remoteTreeSha = 'TREE_0';
  remoteRefSha = 'COMMIT_0';
  remoteParentSha = 'PARENT_0';
  callCount = 0;
  installFakeFetch();
  vi.restoreAllMocks();
});

describe('推送编排（store 层）', () => {
  it('本地改动会推到远端', async () => {
    const old = '旧内容';
    const sha = await blobShaOfText(old);
    remote = { '甲.md': old };
    remoteTreeSha = 'TREE_remote';
    remoteRefSha = 'COMMIT_remote';
    const meta: Meta = {
      ...emptyMeta(),
      lastCommit: 'COMMIT_remote',
      lastTree: 'TREE_remote',
      notes: { '甲.md': entry('甲.md', sha, sha, sha, FLAG.DIRTY) },
    };
    await boot({ '甲.md': '新内容' }, meta);
    useNotes.getState().openNote('甲.md');

    await useNotes.getState().pushNow();

    expect(useNotes.getState().error).toBeNull();
    expect(remote['甲.md']).toBe('新内容');
    expect(useNotes.getState().pushDirty).toBe(0);
  });

  it('本地删过的笔记会被推到远端删掉（墓碑）', async () => {
    const content = '要被删掉的内容';
    const sha = await blobShaOfText(content);
    remote = { '乙.md': content };
    remoteTreeSha = 'TREE_remote';
    remoteRefSha = 'COMMIT_remote';
    const meta: Meta = {
      ...emptyMeta(),
      lastCommit: 'COMMIT_remote',
      lastTree: 'TREE_remote',
      notes: { '乙.md': entry('乙.md', sha, sha, sha) },
      removed: ['乙.md'],
    };
    // 磁盘上已经没有它了（软删除后只剩 trash）
    await boot({}, meta);

    await useNotes.getState().pushNow();

    expect(useNotes.getState().error).toBeNull();
    expect(remote['乙.md']).toBeUndefined(); // 远端真的没了
    expect(useNotes.getState().meta.removed).toEqual([]); // 墓碑已清
  });

  it('清单重建丢了远端记录时，也不能凭"本地有、远端没有"就推', async () => {
    // 磁盘上有一篇"早就同步过"的笔记，但清单里的记录丢了本地 sha（模拟重建）
    // 没有脏标记 → 不该推
    const content = '早就同步过的内容';
    const sha = await blobShaOfText(content);
    remote = { '丙.md': content };
    remoteTreeSha = 'TREE_remote';
    remoteRefSha = 'COMMIT_remote';
    const meta: Meta = { ...emptyMeta(), lastCommit: 'COMMIT_remote', lastTree: 'TREE_remote', notes: {} };
    void sha;
    await boot({ '丙.md': content }, meta);

    await useNotes.getState().pushNow();

    expect(useNotes.getState().error).toBeNull();
    expect(remoteTreeSha).toBe('TREE_remote'); // 远端没有被推过（树没变）
  });

  it('远端在推送前被别处推过 → 先并入再推，不覆盖别人', async () => {
    const mine = '我改的';
    const sha = await blobShaOfText('原始');
    remote = { '丁.md': '原始', '别人加的.md': '别处的内容' };
    remoteTreeSha = 'TREE_remote';
    remoteRefSha = 'COMMIT_remote';
    const meta: Meta = {
      ...emptyMeta(),
      lastCommit: 'COMMIT_remote',
      lastTree: 'TREE_remote',
      notes: { '丁.md': entry('丁.md', sha, sha, sha, FLAG.DIRTY) },
    };
    await boot({ '丁.md': mine }, meta);
    useNotes.getState().openNote('丁.md');

    await useNotes.getState().pushNow();

    expect(useNotes.getState().error).toBeNull();
    expect(remote['丁.md']).toBe(mine);
    expect(remote['别人加的.md']).toBe('别处的内容'); // 别处的改动没被动过
  });

  it('推送失败时报错，且脏标记保留（宁可重复推，绝不漏推）', async () => {
    const sha = await blobShaOfText('原始');
    remote = { '戊.md': '原始' };
    remoteTreeSha = 'TREE_remote';
    remoteRefSha = 'COMMIT_remote';
    const meta: Meta = {
      ...emptyMeta(),
      lastCommit: 'COMMIT_remote',
      lastTree: 'TREE_remote',
      notes: { '戊.md': entry('戊.md', sha, sha, sha, FLAG.DIRTY) },
    };
    await boot({ '戊.md': '改过了' }, meta);
    useNotes.getState().openNote('戊.md');
    // 让建树请求失败
    __setFetchForTest((async () => new Response('{}', { status: 500 })) as typeof fetch);

    await useNotes.getState().pushNow();

    expect(useNotes.getState().error).not.toBeNull();
    expect(useNotes.getState().meta.notes['戊.md']?.flags).toBe(FLAG.DIRTY);
  });
});
