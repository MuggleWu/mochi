import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '@core/fs/memory-fs';
import { META_FILE } from '@core/fs/layout';
import { loadSettings, normalizeRepo, saveSettings } from './settings';

describe('normalizeRepo', () => {
  it('三种写法都得到同一个结果（用户明确要求的兼容）', () => {
    const want = 'owner/name';
    expect(normalizeRepo('owner/name')).toBe(want);
    expect(normalizeRepo('https://github.com/owner/name')).toBe(want);
    expect(normalizeRepo('https://github.com/owner/name.git')).toBe(want);
  });

  it('前后空白与末尾斜杠不算错', () => {
    expect(normalizeRepo('  owner/name  ')).toBe('owner/name');
    expect(normalizeRepo('https://github.com/owner/name/')).toBe('owner/name');
    expect(normalizeRepo('  https://github.com/owner/name.git  ')).toBe('owner/name');
    expect(normalizeRepo('https://github.com/owner/name.git/')).toBe('owner/name');
  });

  it('没有协议、没有 www、大写 GitHub 也能认出来', () => {
    expect(normalizeRepo('github.com/owner/name')).toBe('owner/name');
    expect(normalizeRepo('www.github.com/owner/name')).toBe('owner/name');
    expect(normalizeRepo('HTTPS://GitHub.com/owner/name')).toBe('owner/name');
  });

  it('网页深链接只取仓库那两段（用户从浏览器地址栏复制的情况）', () => {
    expect(normalizeRepo('https://github.com/owner/name/tree/master/notes')).toBe('owner/name');
    expect(normalizeRepo('https://github.com/owner/name/blob/master/a.md')).toBe('owner/name');
    expect(normalizeRepo('https://github.com/owner/name?tab=readme')).toBe('owner/name');
    expect(normalizeRepo('https://github.com/owner/name#readme')).toBe('owner/name');
  });

  it('认不出来就原样返回，交给网络层报 404（绝不在这里抛错）', () => {
    // 这些都不该被"猜"：猜出来的地址会让用户查错方向
    expect(normalizeRepo('随便写的')).toBe('随便写的');
    expect(normalizeRepo('https://github.com/onlyowner')).toBe('https://github.com/onlyowner');
    expect(normalizeRepo('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b');
    expect(normalizeRepo('')).toBe('');
    expect(normalizeRepo('   ')).toBe('');
  });

  it('幂等：归一过的再归一不变', () => {
    for (const input of ['owner/name', 'https://github.com/owner/name.git', 'a/b/c/d']) {
      const once = normalizeRepo(input);
      expect(normalizeRepo(once)).toBe(once);
    }
  });
});

describe('设置里存的一律是归一后的形状', () => {
  it('存完整 URL，读回来是 owner/name', async () => {
    const fs = new MemoryFileStore();
    await saveSettings(fs, { repo: 'https://github.com/owner/repo.git', branch: 'master', token: 't' });
    const loaded = await loadSettings(fs);
    expect(loaded.repo).toBe('owner/repo');
  });

  it('磁盘上的文件里存的也是归一后的形状（下游不必各自兼容）', async () => {
    const fs = new MemoryFileStore();
    await saveSettings(fs, { repo: 'https://github.com/owner/repo', branch: 'master', token: 't' });
    expect(await fs.readText(META_FILE)).toContain('"repo":"owner/repo"');
  });

  it('读到老版本存的完整 URL 也会被归一（不用让用户重填）', async () => {
    const fs = new MemoryFileStore();
    await fs.writeText(META_FILE, JSON.stringify({ repo: 'https://github.com/owner/repo.git', branch: 'main', token: 't' }));
    const loaded = await loadSettings(fs);
    expect(loaded.repo).toBe('owner/repo');
    expect(loaded.branch).toBe('main');
  });
});
