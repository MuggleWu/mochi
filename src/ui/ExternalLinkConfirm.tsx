/**
 * 外链确认弹层：点正文里的 http(s) 链接时，先问一句再交给系统浏览器。
 *
 * **为什么要问**：笔记里的链接是长期沉淀下来的，点错一下就会离开应用、跳到浏览器；
 * 手机上从浏览器切回来往往要重新找位置。这不是安全门禁（链接内容本身不可信这件事
 * 不该靠这个弹层解决），纯粹是"别让一次误触打断阅读"。
 *
 * 顺带一个好处：链接地址**完整显示**出来。正文里的链接文字常常是"这里"、"参考"之类，
 * 看不出要去哪；手机上又没有桌面浏览器那种悬停预览，所以只能在这里告诉他。
 *
 * 打开方式用的是真正的网页导航（点一个 `<a href>`），而不是 `window.open`：
 * Capacitor 的 WebView 客户端把 http(s) 导航交给系统处理（`shouldOverrideUrlLoading`
 * → `launchIntent`），照原样导航就能落到系统浏览器；自己另找 API 反而要处理
 * 平台差异。
 */
import { useEffect, useState } from 'react';

/** 真正执行"打开外链"。抽成依赖是为了能让测试钉住"只有确认之后才打开"。 */
export type OpenExternal = (url: string) => void;

const defaultOpen: OpenExternal = (url) => {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const btn: React.CSSProperties = {
  flex: 1,
  padding: '9px 8px',
  fontSize: 14,
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'var(--bg-soft)',
  color: 'var(--fg)',
  cursor: 'pointer',
};

export function ExternalLinkConfirm({
  url,
  onClose,
  open = defaultOpen,
}: {
  /** 待确认的地址；空串表示没有待确认的。 */
  url: string;
  onClose: () => void;
  open?: OpenExternal;
}): React.JSX.Element | null {
  // 打开过一次就不再重复打开：弹层关闭时 `url` 变空，这里要记住"这家已经办完了"
  const [opened, setOpened] = useState('');

  useEffect(() => {
    if (!url) setOpened('');
  }, [url]);

  if (!url) return null;

  const host = ((): string => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  return (
    <div className="scrim open" onClick={onClose}>
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 16,
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>在浏览器里打开？</div>
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4 }}>
          会离开 mochi，跳到 {host}
        </div>
        {/* 完整地址：链接文字常常只是"这里"，看不出要去哪 */}
        <div
          style={{
            fontSize: 12,
            wordBreak: 'break-all',
            background: 'var(--bg-soft)',
            borderRadius: 8,
            padding: '8px 10px',
            marginBottom: 12,
            maxHeight: 96,
            overflowY: 'auto',
          }}
        >
          {url}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={btn} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            style={{ ...btn, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
            onClick={() => {
              if (opened === url) return; // 双击不再打开一次
              setOpened(url);
              open(url);
              onClose();
            }}
          >
            打开
          </button>
        </div>
      </div>
    </div>
  );
}
