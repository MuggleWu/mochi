/**
 * 「离开时的样子」的序列化。
 *
 * 这个模块的失败方式是特殊的：**它绝不能抛错**。状态文件坏了最多是"没回到上次的样子"，
 * 但若因此让应用起不来，就成了"打不开" —— 严重得多。所以下面相当一部分用例是在喂坏数据。
 */
import { describe, expect, it } from 'vitest';
import { deserializeSession, emptySession, serializeSession } from '@core/fs/session';

describe('状态序列化', () => {
  it('完整往返：存什么读出来就是什么', () => {
    const s = {
      current: '会议记录.md',
      mode: 'edit' as const,
      scrollRatio: 0.42,
      query: '周报',
      draft: '写到一半的内容',
    };
    expect(deserializeSession(serializeSession(s))).toEqual(s);
  });

  it('没有状态文件时给默认值', () => {
    expect(deserializeSession(null)).toEqual(emptySession());
  });

  it('JSON 坏了也不抛错，退回默认值', () => {
    expect(deserializeSession('{ 这不是合法 json')).toEqual(emptySession());
    expect(deserializeSession('null')).toEqual(emptySession());
    expect(deserializeSession('[]')).toEqual(emptySession());
  });

  it('字段类型不对时逐个退回默认值，不整份丢掉', () => {
    // 只要有一处能救回来就救 —— 用户不该因为某个字段写坏了而丢掉全部状态
    const got = deserializeSession(
      JSON.stringify({ current: 123, mode: '乱七八糟', scrollRatio: 'x', query: '能救回来', draft: 5 }),
    );
    expect(got.current).toBeNull();
    expect(got.mode).toBe('read');
    expect(got.scrollRatio).toBe(0);
    expect(got.query).toBe('能救回来');
    expect(got.draft).toBeNull();
  });

  it('阅读位置被夹到 0~1（坏了的位置不该把用户丢到页面外）', () => {
    expect(deserializeSession(JSON.stringify({ scrollRatio: 5 })).scrollRatio).toBe(1);
    expect(deserializeSession(JSON.stringify({ scrollRatio: -3 })).scrollRatio).toBe(0);
    expect(deserializeSession(JSON.stringify({ scrollRatio: Number.NaN })).scrollRatio).toBe(0);
  });

  it('空字符串的 current 当作"没开笔记"', () => {
    expect(deserializeSession(JSON.stringify({ current: '' })).current).toBeNull();
  });
});
