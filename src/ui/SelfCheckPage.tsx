/**
 * 诊断页：把"现在到底什么状态"一次摆清楚。
 *
 * **为什么值得单独做一页**：出错的时候，界面上看到的只是"同步失败"或"点开是空的"，
 * 而真正有用的信息（清单里有多少篇、内容下到哪了、有哪些本地改动没推、上次远端提交
 * 是谁）平时根本不显示。用户遇到问题只能描述现象，没法给出线索；而错误文案里那几处
 * "请查看诊断页"也得有个地方可去。
 *
 * 入口是**长按顶栏的同步按钮**（见 `long-press.ts`），从错误弹窗里也能直接进来。
 *
 * 只读：这一页不提供任何"修复"按钮。能修的（比如重新拉取）在同步面板里都有，
 * 而在这里顺手改数据会把现场毁掉，下次更难查。
 */
import { useEffect, useState } from 'react';
import { NOTES_DIR } from '@core/fs/layout';
import { hasProblem, selfCheck, type SelfCheck } from '@core/fs/self-check';
import { hasRealMtime } from '@core/sync/manifest';
import { getStore, useNotes } from './store';

const box: React.CSSProperties = {
  background: 'var(--bg-soft)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '10px 12px',
  marginBottom: 10,
};

const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
  padding: '3px 0',
};

const key: React.CSSProperties = { color: 'var(--fg-dim)' };
const val: React.CSSProperties = { textAlign: 'right', wordBreak: 'break-all' };

/** 一行"名称：值"。 */
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }): React.JSX.Element {
  return (
    <div style={row}>
      <span style={key}>{k}</span>
      <span style={{ ...val, ...(warn ? { color: 'var(--danger)' } : {}) }}>{v}</span>
    </div>
  );
}

export function SelfCheckPage({ onClose }: { onClose: () => void }): React.JSX.Element {
  const store = getStore();
  const meta = useNotes((s) => s.meta);
  const settings = useNotes((s) => s.settings);
  const error = useNotes((s) => s.error);

  const pullStage = useNotes((s) => s.pullStage);
  const pullDone = useNotes((s) => s.pullDone);
  const pullTotal = useNotes((s) => s.pullTotal);
  const pendingContent = useNotes((s) => s.pendingContent);
  const histNote = useNotes((s) => s.histNote);
  const indexed = useNotes((s) => s.indexed);
  const indexing = useNotes((s) => s.indexing);
  const pushStage = useNotes((s) => s.pushStage);
  const pushDirty = useNotes((s) => s.pushDirty);
  const conflicts = useNotes((s) => s.conflicts);
  const lastSyncNote = useNotes((s) => s.lastSyncNote);

  const [check, setCheck] = useState<SelfCheck | null>(null);
  const [checkError, setCheckError] = useState('');

  /*
   * 自检在打开时跑一次（不是每次渲染都跑）：它要读一次目录，放在渲染里会把界面拖住。
   * 依赖只有清单和文件层，所以清单变了才重跑。
   */
  useEffect(() => {
    if (!store) return;
    let alive = true;
    void selfCheck(store, meta)
      .then((c) => {
        if (alive) setCheck(c);
      })
      .catch((err: unknown) => {
        if (alive) setCheckError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [store, meta]);

  const unknownMtime = Object.values(meta.notes).filter((e) => !hasRealMtime(e)).length;

  return (
    <div className="scrim open" onClick={onClose}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--bg)',
          overflowY: 'auto',
          padding: '12px 14px 24px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>诊断</div>
          <button className="pill" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>连接</div>
          {/* 令牌只报有没有，**不显示内容**：这一页可能会被截图给别人看 */}
          <Row k="仓库" v={settings.repo || '未填写'} warn={!settings.repo} />
          <Row k="分支" v={settings.branch || '未填写'} />
          <Row k="令牌" v={settings.token ? '已填写' : '未填写'} warn={!settings.token} />
        </div>

        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>本地缓存</div>
          {check ? (
            <>
              <Row k="笔记篇数" v={`${check.total}`} />
              <Row k="本地有内容" v={`${check.onDisk}`} warn={check.onDisk !== check.total} />
              <Row k="内容还没下载" v={`${check.missingContent}`} warn={check.missingContent > 0} />
              {/* 时间未知的后果是排序不准，不是数据坏了，所以只提示不标红 */}
              <Row k="修改时间还不知道" v={`${unknownMtime}（这些排不准）`} />
              {check.mismatchTotal > 0 && (
                <>
                  <Row k="清单与磁盘对不上" v={`${check.mismatchTotal} 篇`} warn />
                  {check.mismatches.map((m) => (
                    <div key={`${m.kind}:${m.path}`} style={{ ...row, fontSize: 12 }}>
                      <span style={key}>{m.kind}</span>
                      <span style={val}>{m.path}</span>
                    </div>
                  ))}
                  {check.mismatchTotal > check.mismatches.length && (
                    <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                      只列了前 {check.mismatches.length} 篇
                    </div>
                  )}
                </>
              )}
              {!hasProblem(check) && check.mismatchTotal === 0 && (
                <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                  清单和磁盘对得上，没有发现坏掉的地方。
                </div>
              )}
            </>
          ) : checkError ? (
            <div style={{ fontSize: 13, color: 'var(--danger)' }}>自检跑不动：{checkError}</div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--fg-dim)' }}>正在数…</div>
          )}
        </div>

        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>同步</div>
          <Row k="上次远端提交" v={meta.lastCommit ? meta.lastCommit.slice(0, 12) : '还没有'} />
          <Row k="待推送" v={`${pushDirty} 篇`} warn={pushDirty > 0} />
          <Row k="待决冲突" v={`${conflicts.length} 篇`} warn={conflicts.length > 0} />
          <Row k="待下载内容" v={`${pendingContent} 篇`} />
          {pullStage && <Row k="下载进行中" v={`${pullStage} ${pullDone}/${pullTotal}`} />}
          {pushStage && <Row k="推送进行中" v={pushStage} />}
          {lastSyncNote && <Row k="上次同步" v={lastSyncNote} />}
          {histNote && <Row k="版本历史" v={histNote} />}
        </div>

        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>搜索索引</div>
          <Row k="已索引" v={`${indexed} 篇`} />
          <Row k="状态" v={indexing ? '正在建' : '空闲'} />
          {/* 索引存在 state/ 下，和笔记目录分开；报出来是为了解释"为什么索引坏了不影响笔记 */}
          <Row k="索引文件" v="state/grams.bin" />
          <Row k="笔记目录" v={NOTES_DIR} />
        </div>

        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>上次错误</div>
          <div style={{ fontSize: 13, color: error ? 'var(--danger)' : 'var(--fg-dim)' }}>
            {error ?? '没有记录到错误'}
          </div>
        </div>
      </div>
    </div>
  );
}
