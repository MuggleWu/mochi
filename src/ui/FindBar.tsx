/**
 * 查找栏：阅读态只查找，编辑态多一行替换。
 *
 * 一栏两用而不是做两个组件：查找的输入、计数、上一个/下一个**完全一样**，
 * 分开写会立刻出现两套行为和两处要同时改的 bug。差异只有"要不要替换"，
 * 用一个 `mode` 控制即可。
 *
 * 这里是**受控组件**：查询、当前第几处、是否区分大小写都由调用方持有。
 * 原因是同一个状态编辑器与阅读器都要用（高亮、滚动定位都在它们那边），
 * 组件内部自持会让调用方拿不到当前匹配的位置。
 */
import type { Match } from './find';

export type FindMode = 'read' | 'edit';

interface Props {
  mode: FindMode;
  query: string;
  onQueryChange: (next: string) => void;
  replaceText: string;
  onReplaceTextChange: (next: string) => void;
  matches: Match[];
  /** 当前第几处（0 起）。没有匹配时无意义。 */
  index: number;
  caseSensitive: boolean;
  onToggleCase: () => void;
  onStep: (delta: number) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  /** 计数文案，由 `matchLabel` 算出。 */
  label: string;
  /** 输入框挂载后自动聚焦（按"查找"打开时应当能直接打字）。 */
  autoFocus?: boolean;
}

export function FindBar(props: Props): React.JSX.Element {
  const { mode, query, matches, label } = props;
  const has = matches.length > 0;

  return (
    <div className="find-bar">
      <div className="find-row">
        <input
          className="find-input"
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="查找…"
          autoFocus={props.autoFocus}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // 回车 = 下一个（与桌面编辑器一致，不用去够按钮）
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              props.onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              props.onClose();
            }
          }}
        />
        <span className="find-count">{label}</span>
        <button className="find-btn" onClick={() => props.onStep(-1)} disabled={!has} aria-label="上一个">
          ↑
        </button>
        <button className="find-btn" onClick={() => props.onStep(1)} disabled={!has} aria-label="下一个">
          ↓
        </button>
        <button
          className={`find-btn${props.caseSensitive ? ' on' : ''}`}
          onClick={props.onToggleCase}
          aria-label="区分大小写"
          title="区分大小写"
        >
          Aa
        </button>
        <button className="find-btn" onClick={props.onClose} aria-label="关闭查找">
          ✕
        </button>
      </div>

      {mode === 'edit' && (
        <div className="find-row">
          <input
            className="find-input"
            value={props.replaceText}
            onChange={(e) => props.onReplaceTextChange(e.target.value)}
            placeholder="替换为…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            // 回车 = 替换当前这一处；替换是改内容，所以**不给**快捷键做"全部替换"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                props.onReplaceOne();
              } else if (e.key === 'Escape') {
                props.onClose();
              }
            }}
          />
          <button className="find-btn wide" onClick={props.onReplaceOne} disabled={!has}>
            替换
          </button>
          <button className="find-btn wide" onClick={props.onReplaceAll} disabled={!has}>
            全部替换
          </button>
        </div>
      )}
    </div>
  );
}
