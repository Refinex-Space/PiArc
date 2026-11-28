// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { BackgroundTask } from '@piarc/protocol';
import { TerminalPanel } from './TerminalPanel.js';

let tasks: readonly BackgroundTask[] = [];
vi.mock('../store/hooks.js', () => ({ useTasks: () => tasks }));
vi.mock('../app/app-context.js', () => ({ useT: () => (id: string) => id }));
vi.mock('./events.js', () => ({ onTerminalEvents: () => () => undefined }));
vi.mock('./TerminalSurface.js', () => ({ TerminalSurface: () => null }));

it('retires the optimistic tab when Core reports an exited shell, even before the running snapshot', async () => {
  const task: BackgroundTask = {
    taskId: 'bg-000000000001',
    sessionId: 'local',
    ownerSessionId: 'local',
    workspace: 'workspace',
    cwd: 'workspace',
    kind: 'terminal',
    title: 'Terminal',
    startedAt: 1,
    status: 'completed',
    outputBytes: 0,
    tail: [],
    terminal: { origin: 'user', shared: false },
  };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', {
    openSessionTerminal: () => Promise.resolve({ taskId: task.taskId, terminalId: 1 }),
    terminalInfo: () => Promise.resolve({ title: 'Shell' }),
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(<TerminalPanel sessionId="local" />);
      await Promise.resolve();
    });
  };
  try {
    await render();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="terminal-new"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="tab"]')).not.toBeNull();
    tasks = [task];
    await render();
    expect(host.querySelector('[role="tab"]')).toBeNull();
    tasks = [];
    await render();
    expect(host.querySelector('[role="tab"]')).toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    tasks = [];
    vi.unstubAllGlobals();
  }
});
