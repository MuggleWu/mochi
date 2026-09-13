/**
 * 「离开时的样子」—— 关掉应用或切到后台再回来，应当接着说上次的事。
 *
 * 为什么必须落盘：Android 随时会因内存压力杀掉后台的 WebView。只存在内存里、
 * 靠 `resume` 事件恢复是不够的 —— 真被杀掉时那样什么都没了。所以状态的**事实源是磁盘**，
 * 进程内的事件只是"尽早写下去"的时机。
 *
 * 存的是"怎么还原"，不是"内容本身"：
 *
 * - 正文平时的来源是磁盘上的笔记文件；只有**改动还没保存**时才额外存一份草稿，
 *   否则每次切后台都把整篇正文写一遍，白费 IO 还拖慢暂停。
 * - 草稿是**唯一能救回未保存改动**的东西。用户写着字切出去、回来发现白写了，是最伤的
 *   一类丢失。所以草稿的写入比其它字段更积极（见 store 里的落盘时机）。
 */

/** 离开时的界面状态。 */
export interface SessionState {
  /** 打开的笔记路径（仓库里的相对路径）。`null` = 当时没开任何笔记。 */
  current: string | null;
  /** 阅读态还是编辑态。 */
  mode: 'read' | 'edit';
  /** 阅读位置（0~1）。用比例而不是像素：字号/窗口变了也能落在差不多的地方。 */
  scrollRatio: number;
  /** 抽屉里的搜索词（回来时不用重新敲）。 */
  query: string;
  /**
   * 还没有保存的正文；`null` = 没有未保存的改动。
   *
   * 只有编辑态且真的改过才会有值 —— 所以正常情况下这个字段是 `null`，
   * 不会让每次切后台都写一遍整篇正文。
   */
  draft: string | null;
}

/** 什么都没开时的初始状态。 */
export function emptySession(): SessionState {
  return { current: null, mode: 'read', scrollRatio: 0, query: '', draft: null };
}

const clampRatio = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, v));
};

/**
 * 反序列化。任何一处不对就退回默认值 ——
 * **这里绝不抛错**：状态文件坏了最多是"没恢复到上次的样子"，若因此让应用起不来，
 * 就成了"打不开"，那是严重得多的问题。
 */
export function deserializeSession(raw: string | null): SessionState {
  const out = emptySession();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const p = parsed as Record<string, unknown>;

  if (typeof p.current === 'string' && p.current !== '') out.current = p.current;
  if (p.mode === 'edit') out.mode = 'edit';
  out.scrollRatio = clampRatio(p.scrollRatio);
  if (typeof p.query === 'string') out.query = p.query;
  if (typeof p.draft === 'string') out.draft = p.draft;
  return out;
}

export function serializeSession(s: SessionState): string {
  return JSON.stringify({
    version: 1,
    current: s.current,
    mode: s.mode,
    scrollRatio: clampRatio(s.scrollRatio),
    query: s.query,
    draft: s.draft,
  });
}
