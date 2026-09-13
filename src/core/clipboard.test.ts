/**
 * 「复制当前笔记」的测试。
 *
 * 两条最容易出错、也最该钉死的：
 *
 * 1. **贴出去的内容长什么样**（标题要不要补、什么时候不补）—— 这是功能的价值所在；
 * 2. **失败必须说话** —— 让用户以为复制成功、结果粘出空内容，比直接报错糟得多。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clipboardText, __setClipboardForTest, writeClipboardText } from '@core/clipboard';

describe('拼装要复制的内容', () => {
  it('默认把标题补成一级标题放在正文前', () => {
    // 贴给别人时，没有标题的正文常常读不懂
    expect(clipboardText('会议记录', '今天定了三件事')).toBe('# 会议记录\n\n今天定了三件事');
  });

  it('正文开头已经是一级标题时不再补，避免出现两个同样的标题', () => {
    expect(clipboardText('会议记录', '# 会议记录\n\n正文')).toBe('# 会议记录\n\n正文');
  });

  it('只在开头判断，不搜全文（正文里引用别处标题不该被误判）', () => {
    expect(clipboardText('会议记录', '前言\n\n# 会议记录\n\n正文')).toBe(
      '# 会议记录\n\n前言\n\n# 会议记录\n\n正文',
    );
  });

  it('不加标题时原样给出正文', () => {
    expect(clipboardText('会议记录', '# 会议记录\n\n正文', { withTitle: false })).toBe('# 会议记录\n\n正文');
  });

  it('标题为空时不硬造一个空标题行', () => {
    expect(clipboardText('', '正文')).toBe('正文');
    expect(clipboardText('   ', '正文')).toBe('正文');
  });

  it('两头的空白不会带进剪贴板', () => {
    expect(clipboardText('标题', '\n\n正文\n\n')).toBe('# 标题\n\n正文');
  });
});

describe('剪贴板写入', () => {
  afterEach(() => __setClipboardForTest(null));

  it('替身注入后，写入的内容原样送达', async () => {
    const seen: string[] = [];
    __setClipboardForTest(async (text) => {
      seen.push(text);
    });
    await writeClipboardText('要复制的东西');
    expect(seen).toEqual(['要复制的东西']);
  });

  it('写入失败会抛错（调用方必须先处理，不能悄悄吞掉）', async () => {
    __setClipboardForTest(async () => {
      throw new Error('系统剪贴板不可用');
    });
    await expect(writeClipboardText('x')).rejects.toThrow('系统剪贴板不可用');
  });
});
