import { describe, expect, it } from 'vitest';
import { BACK_LAYERS, decideBack, type BackContext } from './back-stack';

/** 什么都没开：主页面，返回键应当交给系统（= 退出应用）。 */
const idle: BackContext = { menu: false, rename: false, sync: false, find: false, drawer: false, editing: false };

const ctx = (over: Partial<BackContext>): BackContext => ({ ...idle, ...over });

describe('返回键优先级', () => {
  it('什么都没开 → 交给系统退出应用', () => {
    expect(decideBack(idle)).toEqual({ kind: 'exit' });
  });

  it('抽屉开着 → 先收抽屉，不退出', () => {
    // 用户描述的正是这条：抽屉展开时按返回没有收回效果，直接退出了应用
    expect(decideBack(ctx({ drawer: true }))).toEqual({ kind: 'close', layer: 'drawer' });
  });

  it('弹层开着时永远先关弹层，哪怕抽屉也开着', () => {
    expect(decideBack(ctx({ sync: true, drawer: true }))).toEqual({ kind: 'close', layer: 'sync' });
    expect(decideBack(ctx({ rename: true, sync: true, drawer: true }))).toEqual({ kind: 'close', layer: 'rename' });
  });

  it('查找栏排在抽屉前面（临时浮层先关）', () => {
    expect(decideBack(ctx({ find: true, drawer: true }))).toEqual({ kind: 'close', layer: 'find' });
  });

  it('「更多」菜单开着 → 先收菜单（浮层最优先）', () => {
    // 菜单是临时浮层，用户按返回是想关它；若判成 exit 就是一次误退应用
    expect(decideBack(ctx({ menu: true }))).toEqual({ kind: 'close', layer: 'menu' });
    expect(decideBack(ctx({ menu: true, drawer: true, editing: true }))).toEqual({
      kind: 'close',
      layer: 'menu',
    });
  });

  it('编辑态 → 退回阅读态，绝不直接退出应用', () => {
    // 打字时误触返回就把应用关掉，未保存的内容会丢
    expect(decideBack(ctx({ editing: true }))).toEqual({ kind: 'close', layer: 'editor' });
    expect(decideBack(ctx({ editing: true })).kind).not.toBe('exit');
  });

  it('一层层退：编辑态 → 阅读态 → 才退出', () => {
    const first = decideBack(ctx({ editing: true, drawer: true, find: true }));
    expect(first).toEqual({ kind: 'close', layer: 'find' });
  });

  it('只有"真的什么都没有"才退出', () => {
    for (const layer of BACK_LAYERS) {
      const only: BackContext = { ...idle, [layer === 'editor' ? 'editing' : layer]: true } as BackContext;
      expect(decideBack(only).kind, `只开着 ${layer} 时不该退出`).toBe('close');
    }
  });
});
