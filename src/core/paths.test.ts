/**
 * 路径与文件名规则的单测。
 *
 * 实测依据（2026-09-12，真实仓库根目录 10,076 个文件）：
 *   非法字符 0、Windows 保留名 0、结尾点/空格 0、最长文件名 180 字节。
 * 这些约束本身仍要校验，因为"新建笔记"会产生仓库里没出现过的名字。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_NAME_BYTES,
  checkNoteName,
  displayTitle,
  isNoteName,
  phoneSideName,
  sanitizeNoteName,
  titleFromContent,
  truncateToBytes,
  uniqueNoteName,
  withMdExt,
} from './paths';

describe('checkNoteName', () => {
  it('放行真实库里最长的那个文件名（180 字节）', () => {
    const name = 'cip-marketing-14489 【工程局、股份0315】请示管理表单调整：新增投标相关字段、修改资源协调日期填写方式，并且支持引用投标文件评审.md';
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(checkNoteName(name).ok).toBe(true);
  });

  it('拦截空名、首尾空格、结尾点', () => {
    expect(checkNoteName('').ok).toBe(false);
    expect(checkNoteName(' 名字.md').ok).toBe(false);
    expect(checkNoteName('名字 .md').ok).toBe(false);
    expect(checkNoteName('名字.md.').ok).toBe(false);
  });

  it('拦截非法字符与控制字符', () => {
    for (const bad of ['a:b.md', 'a*b.md', 'a?b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'a/b.md', 'a\\b.md']) {
      expect(checkNoteName(bad).ok, bad).toBe(false);
    }
    expect(checkNoteName('a\u0000b.md').ok).toBe(false);
    expect(checkNoteName('a\nb.md').ok).toBe(false);
  });

  it('拦截 Windows 保留名（大小写无关，且只看基名）', () => {
    expect(checkNoteName('CON.md').ok).toBe(false);
    expect(checkNoteName('con.md').ok).toBe(false);
    expect(checkNoteName('LPT9.md').ok).toBe(false);
    expect(checkNoteName('CONSOLE.md').ok).toBe(true); // 不是保留名
  });

  it('超长按字节拦截（中文一字 3 字节）', () => {
    const shortOk = '中'.repeat(80) + '.md'; // 240 + 3 = 243
    expect(checkNoteName(shortOk).ok).toBe(true);
    const tooLong = '中'.repeat(90) + '.md'; // 270 + 3
    const r = checkNoteName(tooLong);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('过长');
  });
});

describe('sanitizeNoteName', () => {
  it('去掉 markdown 结构性前缀当标题', () => {
    expect(sanitizeNoteName('## 会议记录')).toBe('会议记录.md');
    expect(sanitizeNoteName('- 待办事项')).toBe('待办事项.md');
    expect(sanitizeNoteName('> 引用的一句话')).toBe('引用的一句话.md');
  });

  it('替换非法字符为空格并压紧空白', () => {
    expect(sanitizeNoteName('a/b:c*d')).toBe('a b c d.md');
    expect(sanitizeNoteName('多个    空格')).toBe('多个 空格.md');
  });

  it('空标题兜底为「未命名」', () => {
    expect(sanitizeNoteName('')).toBe('未命名.md');
    expect(sanitizeNoteName('   ')).toBe('未命名.md');
    expect(sanitizeNoteName('###')).toBe('未命名.md');
  });

  it('超长标题按字节截断且不切开中文字符', () => {
    const name = sanitizeNoteName('中'.repeat(200));
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toContain('\uFFFD');
  });

  it('清洗结果自身必须通过校验（幂等性）', () => {
    for (const raw of ['CON', 'a\u0000b', '结尾点.', '   ', '中文标题', 'a/b\\c']) {
      expect(checkNoteName(sanitizeNoteName(raw)).ok, raw).toBe(true);
    }
  });
});

describe('truncateToBytes', () => {
  it('不切开多字节字符', () => {
    const s = '中文中文';
    expect(truncateToBytes(s, 7)).toBe('中文'); // 6 字节放得下，9 字节放不下
    expect(truncateToBytes(s, 6)).toBe('中文');
    expect(truncateToBytes(s, 5)).toBe('中');
    expect(truncateToBytes(s, 100)).toBe(s);
  });
});

describe('展示与命名工具', () => {
  it('displayTitle / withMdExt / isNoteName', () => {
    expect(displayTitle('读书笔记.md')).toBe('读书笔记');
    expect(displayTitle('读书笔记')).toBe('读书笔记');
    expect(withMdExt('新笔记')).toBe('新笔记.md');
    expect(withMdExt('新笔记.MD')).toBe('新笔记.MD');
    expect(isNoteName('a.md')).toBe(true);
    expect(isNoteName('a.txt')).toBe(false);
    expect(isNoteName('.obsidian/app.json')).toBe(false);
  });

  it('uniqueNoteName 依次让路', () => {
    const taken = new Set(['标题.md', '标题（2）.md']);
    expect(uniqueNoteName('标题.md', (p) => taken.has(p))).toBe('标题（3）.md');
    expect(uniqueNoteName('新标题.md', (p) => taken.has(p))).toBe('新标题.md');
  });

  it('phoneSideName 按分钟打时间戳（冲突"都保留"用）', () => {
    const at = new Date(2026, 8, 12, 9, 5); // 2026-09-12 09:05
    expect(phoneSideName('读书笔记.md', at)).toBe('读书笔记（手机版 2026-09-12 0905）.md');
  });

  it('titleFromContent 取首个非空行', () => {
    expect(titleFromContent('\n\n# 真标题\n正文')).toBe('# 真标题');
    expect(titleFromContent('')).toBe('');
  });
});
