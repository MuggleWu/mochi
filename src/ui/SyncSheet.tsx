/**
 * 同步弹层：填仓库/分支/令牌 + 触发拉取。
 *
 * 红线：令牌只写进应用私有目录的设置文件；界面上永不回显完整令牌；
 * 错误提示里也不会带出令牌内容。
 */
import { useState } from 'react';
import { useNotes } from './store';

interface Props {
  onClose: () => void;
}

export function SyncSheet({ onClose }: Props): React.JSX.Element {
  const settings = useNotes((s) => s.settings);
  const saveConfig = useNotes((s) => s.saveConfig);
  const pullMetadata = useNotes((s) => s.pullMetadata);
  const syncStage = useNotes((s) => s.syncStage);
  const lastSyncNote = useNotes((s) => s.lastSyncNote);
  const ready = useNotes((s) => s.ready);

  const [repo, setRepo] = useState(settings.repo);
  const [branch, setBranch] = useState(settings.branch || 'master');
  const [token, setToken] = useState(settings.token);
  const [busy, setBusy] = useState(false);

  const configured = Boolean(repo && token && branch);
  const repoLooksOk = !repo || /^[^/\s]+\/[^/\s]+$/.test(repo);

  const run = async (): Promise<void> => {
    setBusy(true);
    await saveConfig({ repo: repo.trim(), branch: branch.trim() || 'master', token: token.trim() });
    await pullMetadata();
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

        <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', marginBottom: 4 }}>仓库（owner/name）</label>
        <input
          style={field}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="例如 your-name/your-notes"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {!repoLooksOk && (
          <div style={{ color: '#b3261e', fontSize: 12, marginTop: 4 }}>要写成 owner/name 的形式</div>
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
          <button className="pill" disabled={!configured || !repoLooksOk || busy} onClick={() => void run()} style={{ marginLeft: 'auto' }}>
            {busy || syncStage ? syncStage || '同步中…' : '保存并拉取'}
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div>{ready ? lastSyncNote : '启动中…'}</div>
          <div style={{ marginTop: 4 }}>当前阶段只拉取「笔记清单」（不下载内容）；内容按需下载与推送在后续阶段接入。</div>
        </div>
      </div>
    </div>
  );
}
