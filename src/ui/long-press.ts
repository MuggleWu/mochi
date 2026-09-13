/**
 * 长按触发（用于诊断页的隐藏入口）。
 *
 * **为什么要隐藏入口**：诊断页是排障用的，日常使用完全不需要。放在明面上会占掉顶栏
 * 本来就紧张的位置，而且那上面全是"打开目录 / 同步 / 查找"这类高频项，多一个冷门按钮
 * 只会让人犹豫。但也不能藏到用户找不到 —— 错误文案里那几处"请查看诊断页"必须有地方可去，
 * 否则等于指了个不存在的门。
 *
 * 长按的判定要点：
 * * 手指**移动超过阈值就取消** —— 手机上按住时手抖是常态，不取消的话滚动一下就误触。
 * * 时间到了**先触发、再让 `click` 失效**，否则长按会连带触发一次短按（同步按钮上就是
 *   长按打开了诊断页、抬手又点开同步面板）。
 */
import { useRef } from 'react';

/** 按住多久算长按（毫秒）。 */
export const LONG_PRESS_MS = 600;
/** 手指移动超过这么多像素就认为是在滚动，不是长按。 */
export const MOVE_TOLERANCE = 12;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * 把长按与短按绑到同一个元素上。
 *
 * `onLongPress` 触发过之后会**吃掉紧接着那次 click**，避免"长按又触发短按"。
 */
export function useLongPress(onLongPress: () => void, onTap: () => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** 这次按下是否已经触发过长按；触发过就把随后的 click 吞掉。 */
  const fired = useRef(false);

  const clear = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  };

  return {
    onPointerDown: (e) => {
      clear();
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e) => {
      const o = origin.current;
      if (!o) return;
      if (Math.abs(e.clientX - o.x) > MOVE_TOLERANCE || Math.abs(e.clientY - o.y) > MOVE_TOLERANCE) {
        clear();
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClick: (e) => {
      if (fired.current) {
        // 长按已经办完事，这次 click 是它的余波
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
        return;
      }
      onTap();
    },
  };
}
