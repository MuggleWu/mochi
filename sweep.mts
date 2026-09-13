/** 清掉自测分支上的测试残留（只删 zz- / 未命名 开头的）。 */
const PAT = process.env.MOCHI_PAT!;
const repo = process.env.MOCHI_E2E_REPO ?? 'owner/name';
const BR = process.env.MOCHI_E2E_BRANCH ?? 'mochi-selftest';
const H = { Authorization: `Bearer ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'm' };
const j = async (u: string, m = 'GET', b?: unknown): Promise<any> =>
  (await fetch(u, { method: m, headers: { ...H, ...(b ? { 'Content-Type': 'application/json' } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) })).json();

const head = (await j(`https://api.github.com/repos/${repo}/branches/${BR}`)).commit.sha;
const commit = await j(`https://api.github.com/repos/${repo}/git/commits/${head}`);
const tree = (await j(`https://api.github.com/repos/${repo}/git/trees/${head}?recursive=0`)).tree as { path: string; type: string }[];
const junk = tree.filter((e) => e.type === 'blob' && (e.path.startsWith('zz-') || e.path.startsWith('未命名')));
if (junk.length) {
  const t = await j(`https://api.github.com/repos/${repo}/git/trees`, 'POST', {
    base_tree: commit.tree.sha,
    tree: junk.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: null })),
  });
  const nc = await j(`https://api.github.com/repos/${repo}/git/commits`, 'POST', { message: '清理自测残留', tree: t.sha, parents: [head] });
  await j(`https://api.github.com/repos/${repo}/git/refs/heads/${BR}`, 'PATCH', { sha: nc.sha, force: false });
}
const after = (await j(`https://api.github.com/repos/${repo}/branches/${BR}`)).commit.sha;
const t2 = (await j(`https://api.github.com/repos/${repo}/git/trees/${after}?recursive=0`)).tree as { path: string; type: string }[];
console.log(`  清掉 ${junk.length} 个残留；分支根 md=${t2.filter((e) => e.type === 'blob' && e.path.endsWith('.md')).length}`);
