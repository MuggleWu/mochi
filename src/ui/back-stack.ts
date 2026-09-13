/**
 * Android 返回键该做什么 —— 纯函数，便于单测。
 *
 * 为什么单独抽出来：返回键是**唯一一个"越界就退出应用"的交互**。判错一级，
 * 用户轻则白按一次、重则正在写的内容直接没了。所以优先级必须写死、可测，
 * 而不是散在组件里靠 if 顺序碰运气。
 */

/** 当前可能挡在最前面的东西。顺序即优先级，靠上优先被返回键收掉。 */
export const BACK_LAYERS = ['rename', 'sync', 'find', 'drawer', 'editor'] as const;

export type BackLayer = (typeof BACK_LAYERS)[number];

export interface BackContext {
  /** 改名弹窗开着 */
  rename: boolean;
  /** 同步设置弹层开着 */
  sync: boolean;
  /** 查找栏开着 */
  find: boolean;
  /** 抽屉开着 */
  drawer: boolean;
  /** 处于编辑态 */
  editing: boolean;
}

/** 返回键的处置结果。 */
export type BackAction = { kind: 'close'; layer: BackLayer } | { kind: 'exit' };

/**
 * 决定返回键的第一步动作：**先收最上面的那一层**，一层层退，退无可退才交给
 * 系统去退出应用。这样"按几下返回才退出"的直觉成立，而不是一按就没了。
 *
 * 两层排序的理由：
 *
 * - `find` 排在 `drawer` 前：查找栏是临时浮层，用户按返回是想关它，
 *   而不是想把下面的抽屉一起收掉。
 * - `editor` 排在最后：编辑态按返回先退回阅读态（调用方**必须先保存**，
 *   否则用户以为"退出来了"其实改动丢了）。它不能直接 exit —— 打字时误触
 *   返回就把整个应用关掉，那是真丢东西。
 */
export function decideBack(ctx: BackContext): BackAction {
  if (ctx.rename) return { kind: 'close', layer: 'rename' };
  if (ctx.sync) return { kind: 'close', layer: 'sync' };
  if (ctx.find) return { kind: 'close', layer: 'find' };
  if (ctx.drawer) return { kind: 'close', layer: 'drawer' };
  if (ctx.editing) return { kind: 'close', layer: 'editor' };
  return { kind: 'exit' };
}
