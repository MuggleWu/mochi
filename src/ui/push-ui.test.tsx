// @vitest-environment jsdom
/**
 * 同步面板里"推送"这一块的界面测试。
 *
 * 重点不在排版，在**它敢不敢不打招呼就写**：推送是应用里唯一会把改动写回仓库的动作，
 * 而且按设计，"远端已删、本地没动过"的笔记会在推送时被删掉。少了一次确认，
 * 用户第一次点就可能把别处的笔记删了还毫不知情。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SyncSheet } from './SyncSheet';
import { useNotes } from './store';

const base = useNotes.getState();

function setup(next: Partial<ReturnType<typeof useNotes.getState>> = {}): {
  pushNow: ReturnType<typeof vi.fn>;
} {
  const pushNow = vi.fn(async () => undefined);
  useNotes.setState({
    ...base,
    ready: true,
    settings: { repo: 'owner/name', branch: 'master', token: 't' },
    error: null,
    syncStage: '',
    pushStage: '',
    pushDirty: 0,
    ...next,
    pushNow,
  });
  return { pushNow };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  useNotes.setState(base);
});

describe('推送按钮与二次确认', () => {
  it('默认不推：先给一个按钮，点了才出现确认', () => {
    const { pushNow } = setup({ pushDirty: 3 });
    render(<SyncSheet onClose={() => undefined} />);

    expect(screen.getByText('有 3 篇改动待推送。')).toBeTruthy();
    expect(screen.queryByText('确认推送')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '推送改动' }));
    expect(screen.getByText('确认推送')).toBeTruthy();
    // 只是把确认摆出来，**没有**真的推
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('确认之后才真的推', async () => {
    const { pushNow } = setup({ pushDirty: 1 });
    render(<SyncSheet onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: '推送改动' }));
    fireEvent.click(screen.getByRole('button', { name: '确认推送' }));

    await vi.waitFor(() => expect(pushNow).toHaveBeenCalledTimes(1));
  });

  it('"再想想"能退回去，且什么都不做', () => {
    const { pushNow } = setup({ pushDirty: 1 });
    render(<SyncSheet onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: '推送改动' }));
    fireEvent.click(screen.getByRole('button', { name: '再想想' }));

    expect(screen.queryByText('确认推送')).toBeNull();
    expect(screen.getByRole('button', { name: '推送改动' })).toBeTruthy();
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('确认文案明说会删掉东西（不能让人以为只是"上传改动"）', () => {
    setup({ pushDirty: 2 });
    render(<SyncSheet onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '推送改动' }));

    const text = screen.getByText(/确认推送到仓库/).textContent ?? '';
    expect(text).toContain('删');
  });

  it('没配置仓库时推送按钮不可点', () => {
    setup({ settings: { repo: '', branch: 'master', token: '' } });
    render(<SyncSheet onClose={() => undefined} />);
    expect((screen.getByRole('button', { name: '推送改动' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正在推的时候按钮显示阶段、不显示可点的入口', () => {
    setup({ pushDirty: 1, pushStage: '推送 4 篇改动' });
    render(<SyncSheet onClose={() => undefined} />);
    expect(screen.getByText('推送 4 篇改动')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '推送改动' })).toBeNull();
  });
});
