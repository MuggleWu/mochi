/**
 * 抽屉手势：从关闭状态的左边缘拉出，在打开状态下左拖收回，全程跟手；甩得够快则按方向定结果。
 *
 * 判定规则在 `edge-swipe.ts`（纯函数、有单测），这里只负责接事件、维护一次拖动的状态机、
 * 记录采样以便算速度，以及把偏移写进 store（Drawer 组件照着它渲染 transform）。
 *
 * **为什么用触摸事件而不是 Pointer Events**（这里是真机踩过的坑）：我们最早用
 * Pointer Events + `setPointerCapture`，在 Android WebView 里浏览器一旦把手势判成滚动就会
 * **发 pointercancel 抢走这次手势**，表现是"从左缘拖动完全没反应"（实测：pointerdown 1 次、
 * pointermove 1 次、pointercancel 1 次）。要靠 `touch-action` 才能挡住它，而那又会和列表滚动
 * 耦合。改用触摸事件在 document 上 **被动监听**（`{ passive: true }`，从不 preventDefault）
 * 就根本不会收到 cancel —— 浏览器照常滚动，我们只在"有把握"时动抽屉，其余情况直接退让。
 */
import { useEffect, useRef } from 'react';
import { useNotes } from './store';
import {
  dragAxis,
  dragOffsetFromClosed,
  dragOffsetFromOpen,
  dragVelocity,
  inEdgeZone,
  type DragSample,
  type Point,
} from './edge-swipe';

type Mode = 'undecided' | 'dragging' | 'aborted';

/** 一次拖动的现场。放在 hook 里而不是 state：它每帧都在变，不需要触发渲染。 */
interface Gesture {
  start: Point;
  fromOpen: boolean;
  mode: Mode;
  samples: DragSample[];
}

export function useEdgeSwipe(): void {
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    const reset = (): void => {
      gesture.current = null;
    };

    const pushSample = (g: Gesture, now: Point, t: number): void => {
      g.samples.push({ x: now.x, y: now.y, t });
      // 只需保留速度窗口内的采样，超出的丢掉，避免长按拖动把数组撑大
      if (g.samples.length > 32) g.samples.splice(0, g.samples.length - 32);
    };

    /** 抽屉宽度：已实测过就用实测值，否则按 CSS 公式估算（抽屉还没挂载时量不到）。 */
    const width = (): number => {
      const st = useNotes.getState();
      if (st.drawerWidth > 0) return st.drawerWidth;
      return Math.min(window.innerWidth * 0.84, 380);
    };

    /** 手指移动了：先决定方向，再更新抽屉偏移。 */
    const applyMove = (now: Point, t: number): void => {
      const g = gesture.current;
      if (!g || g.mode === 'aborted') return;
      pushSample(g, now, t);

      if (g.mode === 'undecided') {
        const axis = dragAxis(g.start, now);
        if (axis === 'vertical') {
          // 终态：这一次整个放弃，后面手指又拐回横向也不复活 —— 绝不和列表滚动抢
          g.mode = 'aborted';
          return;
        }
        if (axis !== 'horizontal') return;
        g.mode = 'dragging';
        if (!g.fromOpen) {
          // 先把抽屉挂上（此时偏移 = 全收起），后面的 move 才开始跟手
          useNotes.getState().setDrawer(true);
        }
      }

      const w = width();
      const dx = now.x - g.start.x;
      const offset = g.fromOpen ? dragOffsetFromOpen(dx, w) : dragOffsetFromClosed(dx, w);
      useNotes.getState().setDrawerOffset(offset);
    };

    const onStart = (e: TouchEvent): void => {
      reset();
      if (e.touches.length !== 1) return; // 多指（缩放等）不接管
      const touch = e.touches[0];
      if (!touch) return;
      const { drawerOpen, current } = useNotes.getState();
      const target = e.target instanceof Element ? e.target : null;

      // 编辑态**也接管**，但只认最左缘那条窄带（`inEdgeZone`，很窄）。
      //
      // 曾经这里是一句"编辑态直接不接管"，理由是怕抢了在正文上拖动选择、移动光标。
      // 真机用下来这个取舍是错的：编辑时恰恰最常需要滑出抽屉去换一篇 —— 而那一下就
      // 落在正文左缘，于是"编辑态抽屉打不开"。而长按选文字基本都从正文中间开始，
      // 与这条窄带几乎不重叠。
      //
      // 注意判定顺序：下面"抽屉已开着"的分支不受影响（那时靠 `.drawer` 命中来判断），
      // 所以编辑态下收回抽屉照旧可用。
      // 弹层开着时不接管，免得两层手势打架
      if (document.querySelector('.sheet')) return;
      void current;

      if (drawerOpen) {
        // 抽屉开着时：手指落在抽屉面板上才接管（点在遮罩上由遮罩自己处理关闭）
        if (!target?.closest('.drawer')) return;
        gesture.current = {
          start: { x: touch.clientX, y: touch.clientY },
          fromOpen: true,
          mode: 'undecided',
          samples: [{ x: touch.clientX, y: touch.clientY, t: e.timeStamp }],
        };
        return;
      }

      if (!inEdgeZone(touch.clientX)) return;
      gesture.current = {
        start: { x: touch.clientX, y: touch.clientY },
        fromOpen: false,
        mode: 'undecided',
        samples: [{ x: touch.clientX, y: touch.clientY, t: e.timeStamp }],
      };
    };

    const onMove = (e: TouchEvent): void => {
      const g = gesture.current;
      if (!g) return;
      const touch = e.touches[0];
      if (!touch) return;
      applyMove({ x: touch.clientX, y: touch.clientY }, e.timeStamp);
    };

    const onEnd = (e: TouchEvent): void => {
      const g = gesture.current;
      if (!g) {
        reset();
        return;
      }
      // 快速轻扫有时只送来 touchstart + touchend（中间没有 touchmove）：拿松手点补一次判定。
      // 没有这个兜底，快速轻扫永远判不出方向，抽屉纹丝不动。
      const touch = e.changedTouches?.[0];
      if (touch && g.mode === 'undecided') {
        applyMove({ x: touch.clientX, y: touch.clientY }, e.timeStamp);
      }

      const decided = g.mode === 'dragging';
      const endX = touch?.clientX ?? g.start.x;
      const travelled = Math.abs(endX - g.start.x);
      const velocity = dragVelocity(g.samples);
      reset();
      if (decided) {
        useNotes.getState().settleDrawer({ velocity, travelled });
      }
    };

    // 被动监听：这里只读坐标，不能 preventDefault，也就不会挡住页面滚动
    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart, opts);
      document.removeEventListener('touchmove', onMove, opts);
      document.removeEventListener('touchend', onEnd, opts);
      document.removeEventListener('touchcancel', onEnd, opts);
    };
  }, []);
}
