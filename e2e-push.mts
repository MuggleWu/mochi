/**
 * 真仓库端到端：走应用自己的代码路径（store + GithubClient），不用 git。
 *
 * ⚠️ **只能在临时分支上跑**。它会真的建/改/删远端文件，而且应用一 `init` 就会往本地拉
 * 真实内容 —— 拿真笔记库的主分支做这件事是不可接受的（踩过：真仓库里短暂出现过测试文件）。
 *
 * 用法：MOCHI_PAT=... npx tsx e2e-push.mts
 * 流程照着真实用法：新建 → 写 → 推 → 同步 → 再改 → 再推 → 删 → 再推。
 */
import { rm } from 'node:fs/promises';
import { NodeFileStore } from './src/core/fs/node-fs';
import { GithubClient } from './src/core/net/github';
import { useNotes } from './src/ui/store';

const token = process.env.MOCHI_PAT;
if (!token) throw new Error('需要 MOCHI_PAT（环境变量，别写进文件）');
// 仓库与分支**必须显式给**，不设默认值。写死一个具体仓库名，等于把"某个账号下
// 有这么个库"写进了代码里 —— 那是使用者自己的事，不该由项目替他决定。
const repo = process.env.MOCHI_E2E_REPO;
const branch = process.env.MOCHI_E2E_BRANCH;
if (!repo || !branch) throw new Error('需要 MOCHI_E2E_REPO 与 MOCHI_E2E_BRANCH（用你自己的临时分支）');
if (branch === 'master' || branch === 'main') throw new Error('拒绝在主分支上跑端到端');
const NAME = 'zz-推送自测-可删.md';

let failures = 0;
const check = (b: boolean, msg: string): void => {
  if (!b) failures++;
  console.log(`  ${b ? '✓' : '✗'} ${msg}`);
};

const client = new GithubClient({ token, repo, branch });
const rootTree = async () => {
  const head = await client.getRefHead();
  const commit = await client.getCommit(head);
  return (await client.listTree(commit.treeSha)).entries.filter((e) => !e.path.includes('/'));
};
const readRemote = async (path: string): Promise<string | null> => {
  const hit = (await rootTree()).find((e) => e.path === path);
  return hit ? client.readBlobText(hit.sha) : null;
};
const count = async (): Promise<number> => (await rootTree()).filter((e) => e.path.endsWith('.md')).length;

const baseline = await count();
console.log(`  分支 ${branch} 初始 ${baseline} 篇`);

// 本地状态用**磁盘**并且**跨次复用**。
//
// 用内存层的话每次都是全新本地状态，应用就会把最近一批笔记重新下载一遍 ——
// 一次几百个请求，纯属浪费配额，而且不像真实场景（真实使用里第二次同步只补差量）。
const STATE = process.env.MOCHI_E2E_STATE ?? '/tmp/mochi-e2e-state';
if (process.env.MOCHI_E2E_FRESH === '1') await rm(STATE, { recursive: true, force: true });
const fs = new NodeFileStore(STATE);
// 第一次跑（或状态被清过）时先放一个空文件：建清单时它就已经是"本地已有"，
// 之后拉取就不会把它当成远端新笔记、也不会去下载它。
if (!(await fs.exists(`notes/${NAME}`))) await fs.writeText(`notes/${NAME}`, '');
await useNotes.getState().init(fs);
await useNotes.getState().saveConfig({ repo, branch, token });
await useNotes.getState().openNote(NAME);
await useNotes.getState().pullMetadata();
console.log(`  本地清单 ${Object.keys(useNotes.getState().meta.notes).length} 篇（复用状态目录 ${STATE}）`);
check(useNotes.getState().meta.lastCommit !== '', '基准提交已建立');

// ── 1. 写内容并推送 ────────────────────────────
useNotes.getState().setContent('第一版内容：推送自测。');
await useNotes.getState().saveNote();
await useNotes.getState().pushNow();
check(useNotes.getState().error === null, `推送无错误${useNotes.getState().error ? '（' + useNotes.getState().error + '）' : ''}`);
const r1 = await readRemote(NAME);
check(r1 !== null, '远端出现了这篇笔记');
check((r1 ?? '').includes('第一版内容'), `远端内容正确（${JSON.stringify((r1 ?? '').slice(0, 16))}）`);
check((await count()) === baseline + 1, `远端篇数 ${baseline} → ${await count()}（只多了这一篇）`);
check(useNotes.getState().pushDirty === 0, '推送后待推送计数归零');

// ── 2. 收敛一次（真实用法：打开应用就拉取）──────
await useNotes.getState().pullMetadata();
const entry = useNotes.getState().meta.notes[NAME];
check((entry?.syncedSha ?? '') !== '', '同步后这篇有了共同基准');
check((entry?.syncedSha ?? 'x') === (entry?.localSha ?? 'y'), '共同基准与本地内容一致');

// ── 3. 再改再推 ───────────────────────────────
useNotes.getState().setContent('第二版内容：改过一次。');
await useNotes.getState().saveNote();
await useNotes.getState().pushNow();
check(useNotes.getState().error === null, `第二次推送无错误${useNotes.getState().error ? '（' + useNotes.getState().error + '）' : ''}`);
const r2 = (await readRemote(NAME)) ?? '';
check(r2.includes('第二版内容'), '远端内容已更新');
check(!r2.includes('第一版内容'), '远端不再是旧内容');
check((await count()) === baseline + 1, `再推一次没有多出文件（${await count()}）`);

// ── 4. 删除再推 ───────────────────────────────
await useNotes.getState().deleteNote();
const tombstones = useNotes.getState().meta.removed;
check(tombstones.some((t) => t.path === NAME), '删除留下了墓碑（否则删除传不出去）');
// 墓碑要自带远端 sha：只留路径的话，推送时凑不出有效判定，删除会静默失效
check(Boolean(tombstones.find((t) => t.path === NAME)?.remoteSha), '墓碑自带远端 sha（自足，不依赖别处记忆）');
await useNotes.getState().pushNow();
check(useNotes.getState().error === null, `删除推送无错误${useNotes.getState().error ? '（' + useNotes.getState().error + '）' : ''}`);
check((await readRemote(NAME)) === null, '远端这篇已经消失');
check((await count()) === baseline, `远端篇数回到 ${baseline}（${await count()}）`);
check(useNotes.getState().meta.removed.length === 0, '墓碑已清');

console.log(`\n  ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
