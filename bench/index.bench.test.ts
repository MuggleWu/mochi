/**
 * 索引规模与耗时基准。
 *
 * 为什么单独放 bench/ 而不是 src/：`设计文档 §4.3` 的 11.3 MB / 14.3 秒是**实测值**，
 * 不是断言。混进测试套件会让每次跑测试都慢几十秒，而真机语料规模会变。
 * `vitest.config.ts` 的 include 只收 `src/**`，所以这个文件不会被 `npm test` 带上。
 *
 * 用法：`npm run bench:index`
 *
 * 语料是合成的（形态与真实 vault 一致：中文笔记 + 公式 + 表格），结论看**量级**，
 * 不要拿绝对值当验收线。
 *
 * 这个文件的产物就是"打印给人看的数字"，所以整份放开 no-console。
 */
/* eslint-disable no-console */

import { describe, expect, it } from 'vitest';
import {
  appendNote,
  createIndex,
  finishBuild,
  pruneEmpty,
  search,
  serializeIndex,
  deserializeIndex,
} from '../src/core/search/index';

/** 与真实 vault 同量级：约 1 万篇、每篇约 4 KB 中文笔记。 */
function corpus(): [string, string][] {
  const words = [
    '个人所得税',
    '增值税',
    '企业所得税',
    '财务管理',
    '会计基础',
    '审计',
    '经济法',
    '税法',
    '成本核算',
    '报表分析',
    '预算管理',
    '内部控制',
    '风险管理',
    '资产评估',
    '税务筹划',
  ];
  const notes: [string, string][] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const parts: string[] = [`# 笔记 ${i}`, ''];
    for (let line = 0; line < 100; line += 1) {
      const w1 = words[(i + line) % words.length];
      const w2 = words[(i * 3 + line * 7) % words.length];
      parts.push(`## 第 ${line} 节`, '', `本段讲的是**${w1}**与${w2}的关系，要结合实例理解。`, '');
      if (line % 10 === 0) parts.push('$$', `\\frac{a_{${line}}}{b} = c`, '$$', '');
      if (line % 17 === 0) parts.push('| 项目 | 数值 |', '|---|---|', '| 甲 | 1 |', '');
    }
    notes.push([`笔记${String(i).padStart(5, '0')}.md`, parts.join('\n')]);
  }
  return notes;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

describe('索引规模与耗时（合成语料，看量级不看绝对值）', () => {
  it('一万篇中文笔记', () => {
    const notes = corpus();
    const chars = notes.reduce((n, [, c]) => n + c.length, 0);
    const index = createIndex();

    let t = Date.now();
    for (const [path, content] of notes) appendNote(index, { path, content });
    finishBuild(index);
    const buildMs = Date.now() - t;

    t = Date.now();
    const bytes = serializeIndex(index);
    const serializeMs = Date.now() - t;

    t = Date.now();
    const restored = deserializeIndex(bytes);
    const loadMs = Date.now() - t;

    const empty = pruneEmpty(index);
    const totalPostings = [...index.grams.values()].reduce((n, l) => n + l.length, 0);

    t = Date.now();
    const hits = search(restored, '个人所得税');
    const searchMs = Date.now() - t;

    t = Date.now();
    const common = search(restored, '的');
    const commonMs = Date.now() - t;

    console.log(`  语料：${notes.length} 篇 / ${mb(chars)} 字符`);
    console.log(`  不同 gram：${index.grams.size}（另有 ${empty} 个空列表）`);
    console.log(`  倒排条目：${totalPostings.toLocaleString('en-US')}`);
    console.log(`  构建耗时：${buildMs} ms`);
    console.log(`  序列化：${mb(bytes.length)} / ${serializeMs} ms`);
    console.log(`  反序列化：${loadMs} ms`);
    console.log(`  查询「个人所得税」：${searchMs} ms，命中 ${hits.length} 篇`);
    console.log(`  查询「的」（高频词路径）：${commonMs} ms，命中 ${common.length} 篇`);
    console.log('  对照设计文档：11.3 MB / 464,412 gram / 7,342,066 条目 / 构建 14.3 秒（Python）');

    // 只断言"性质"，不断言数值（数值随机器与语料变）
    expect(hits.length).toBeGreaterThan(0);
    expect(common.length).toBeGreaterThan(0);
    expect(bytes.length).toBeGreaterThan(0);
    expect(index.grams.size).toBeGreaterThan(0);
  }, 600_000);
});
