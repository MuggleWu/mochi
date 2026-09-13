/**
 * 同步弹层：填仓库/分支/令牌 + 触发拉取。
 *
 * 红线：令牌只写进应用私有目录的设置文件；界面上永不回显完整令牌；
 * 错误提示里也不会带出令牌内容。
 */
import { useState } from 'react';
import { normalizeRepo } from '@core/sync/settings';
import { useNotes } from './store';

interface Props {
  onClose: () => void;
}

export function SyncSheet({ onClose }: Props): React.JSX.Element {
  const settings = useNotes((s) => s.settings);
  const saveConfig = useNotes((s) => s.saveConfig);
  const syncNow = useNotes((s) => s.syncNow);
  const syncStage = useNotes((s) => s.syncStage);
  const lastSyncNote = useNotes((s) => s.lastSyncNote);
  const histNote = useNotes((s) => s.histNote);
  const histDone = useNotes((s) => s.histDone);
  const histTotal = useNotes((s) => s.histTotal);
  const ready = useNotes((s) => s.ready);

  const [repo, setRepo] = useState(settings.repo);
  const [branch, setBranch] = useState(settings.branch || 'master');
  const [token, setToken] = useState(settings.token);
  const [busy, setBusy] = useState(false);

  // 校验只认**归一后**的值：用户粘完整 URL（笔记里存的就是那种）是完全正常的操作，
  // 不该被判成格式错误。下面这三种写法都会被归一成同一个 owner/name：
  //   owner/name · https://github.com/owner/name · https://github.com/owner/name.git
  // 归一结果里必须恰好有一个 `/`，且两边非空 —— 这才排除了"归一不了"（原样返回）的情况。
  const normalized = normalizeRepo(repo);
  const slash = normalized.indexOf('/');
  const repoBad = repo.trim() !== '' && (slash <= 0 || slash === normalized.length - 1);
  const configured = Boolean(normalized && token && branch);

  /**
   * 失焦时就把字段换成归一后的值。
   *
   * 为什么要回填而不是只存归一值：用户得**看见**自己粘的 URL 变成了什么，
   * 否则仓库填错了要等同步 404 才知道，而 404 的提示里还列着"令牌没授权"这个可能，
   * 会把人往错方向带。改完立刻可见 = 立刻能自己发现错。
   */
  const tidyRepo = (): void => {
    const next = normalizeRepo(repo);
    if (next !== repo) setRepo(next);
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    const finalRepo = normalizeRepo(repo);
    setRepo(finalRepo); // 让面板里显示的就是真正存下去的值
    await saveConfig({ repo: finalRepo, branch: branch.trim() || 'master', token: token.trim() });
    await syncNow();
    setBusy(false);
    // 成功就自动关：清单已经到手，**内容下载还在后台跑**（顶栏下面会出现进度条），
    // 面板继续开着只会用它的遮罩挡住顶栏，用户还得先点一下才能打开目录。
    //
    // 出错时**不要关**：错误提示就在这个面板里，关了等于把用户要看的下一步操作一起关掉。
    if (!useNotes.getState().error) onClose();
  };

  const field: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line)',
    background: 'var(--bg-soft)',
    color: 'var(--fg)',
    fontSize: 15,
  };

  return (
    <div className="scrim open" onClick={onClose}>
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          top: '12%',
          maxHeight: '76%',
          overflowY: 'auto',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 12 }}>同步设置</div>

        <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', marginBottom: 4 }}>仓库</label>
        <input
          style={field}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onBlur={tidyRepo}
          placeholder="owner/name 或 https://github.com/owner/name"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {repoBad && (
          <div style={{ color: '#b3261e', fontSize: 12, marginTop: 4 }}>
            认不出仓库名。填 owner/name，或直接粘仓库地址（https://github.com/owner/name 这种）。
          </div>
        )}

        <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', margin: '12px 0 4px' }}>分支</label>
        <input style={field} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="master" autoCapitalize="off" spellCheck={false} />

        <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', margin: '12px 0 4px' }}>
          访问令牌（只勾选该仓库的 Contents 读写）
        </label>
        <input
          style={field}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="粘贴令牌"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 6 }}>
          令牌只存在本机应用私有目录；不会写进任何代码或提交。
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          <button className="pill" onClick={onClose}>
            关闭
          </button>
          <button className="pill" disabled={!configured || repoBad || busy} onClick={() => void run()} style={{ marginLeft: 'auto' }}>
            {busy || syncStage ? syncStage || '同步中…' : '保存并拉取'}
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div>{ready ? lastSyncNote : '启动中…'}</div>
          {histTotal > 0 ? (
            <div style={{ marginTop: 4 }}>
              正在核对真实修改时间 {histDone} / {histTotal} 个提交…
            </div>
          ) : histNote ? (
            <div style={{ marginTop: 4 }}>{histNote}</div>
          ) : null}
          <div style={{ marginTop: 4 }}>
            保存后会先取「笔记清单」，然后自动下载最近 300 篇的内容，其余在后台补齐（可暂停）。
            打开某篇而本地没有时会就地拉那一篇。
          </div>
          <div style={{ marginTop: 4 }}>
            清单到手后会顺手核对每篇的真实修改时间（从版本历史反推），这样列表顺序才和电脑上一致。
            第一次装需要走完整段历史（几分钟），中断了下次接着做；之后每次同步只花一两个请求。
            第一次要花几次请求，之后每次同步只多问一次分支头。
          </div>
        </div>
      </div>
    </div>
  );
}
