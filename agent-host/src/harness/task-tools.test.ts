import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import type { ErrorResponse, SuccessResponse } from '@piarc/protocol';

import { CoreBridge } from '../runtime/core-bridge.js';
import { CoreIo, ExecOutputRouter } from '../tools/core-io.js';
import { DEFAULT_PROFILE } from '../tools/profile.js';
import { createBashTool } from '../tools/shell.js';
import { createKillShellTool, createMonitorTool } from './task-tools.js';

interface Sent {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type Answer = { result: unknown } | { error: ErrorResponse['error'] };

/** A CoreIo whose requests are answered by `answer` (a result, or an error object). */
function fakeCore(answer: (request: Sent) => Answer): {
  io: CoreIo;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const bridge: CoreBridge = new CoreBridge((message) => {
    const request = message as Sent;
    sent.push(request);
    queueMicrotask(() => {
      const answered = answer(request);
      const response: SuccessResponse | ErrorResponse =
        'error' in answered
          ? { jsonrpc: '2.0', id: request.id, error: answered.error }
          : { jsonrpc: '2.0', id: request.id, result: answered.result };
      bridge.handleResponse(response);
    });
  });
  return {
    sent,
    io: new CoreIo({
      bridge,
      sessionId: 'sess-1',
      execOutput: new ExecOutputRouter(),
      readBlob: () => Promise.reject(new Error('no blobs')),
    }),
  };
}

const ctx = { cwd: '/w' } as ExtensionToolContext;

const task = {
  taskId: 'bg-0a1b2c3d4e5f',
  sessionId: 'sess-1',
  ownerSessionId: 'sess-1',
  workspace: '/w',
  kind: 'command',
  title: 'npm run dev',
  command: 'npm run dev',
  cwd: '/w',
  status: 'killed',
  startedAt: 1,
  outputPath: '~/d/sessions/sess-1/tasks/bg-0a1b2c3d4e5f.log',
  outputBytes: 30,
};

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  const part = result.content[0];
  return part?.type === 'text' ? (part.text ?? '') : '';
}

describe('KillShell', () => {
  it('stops the task through Core and shows its last lines', async () => {
    const { io, sent } = fakeCore(() => ({
      result: { task, stopped: true, tail: 'ready\nlistening on 5173' },
    }));
    const tool = createKillShellTool(DEFAULT_PROFILE.KillShell, io);
    const result = await tool.execute(
      'toolu_k',
      { shell_id: ' bg-0a1b2c3d4e5f ' },
      undefined,
      undefined,
      ctx,
    );
    expect(sent[0]?.method).toBe('exec/background/kill');
    expect(sent[0]?.params).toMatchObject({ sessionId: 'sess-1', taskId: 'bg-0a1b2c3d4e5f' });
    expect(text(result)).toBe(
      'Task bg-0a1b2c3d4e5f (npm run dev) was stopped together with every process it started.\n' +
        `Its output file stays at ${task.outputPath}.\nIts last lines:\nready\nlistening on 5173`,
    );
  });

  it('says when the task had already ended, and refuses an id the session does not own', async () => {
    const ended = fakeCore(() => ({
      result: { task: { ...task, status: 'completed' }, stopped: false, tail: '' },
    }));
    const tool = createKillShellTool(DEFAULT_PROFILE.KillShell, ended.io);
    const result = await tool.execute(
      'toolu_k',
      { shell_id: task.taskId },
      undefined,
      undefined,
      ctx,
    );
    expect(text(result)).toBe(
      `Task ${task.taskId} had already ended (completed); nothing was stopped.`,
    );
    const other = fakeCore(() => ({
      error: {
        code: -32009,
        message: 'no background task bg-ffffffffffff belongs to this session',
        data: { kind: 'notFound', retryable: false },
      },
    }));
    const refusing = createKillShellTool(DEFAULT_PROFILE.KillShell, other.io);
    await expect(
      refusing.execute('toolu_k', { shell_id: 'bg-ffffffffffff' }, undefined, undefined, ctx),
    ).rejects.toThrow('There is no background task bg-ffffffffffff in this session.');
  });
});

describe('Monitor', () => {
  it('starts the command in Core with its description and timeout', async () => {
    const { io, sent } = fakeCore(() => ({
      result: {
        taskId: 'bg-1a1b2c3d4e5f',
        outputPath: '~/t.log',
        timeoutMs: 1_800_000,
        requestedTimeoutMs: 3_600_000,
      },
    }));
    const tool = createMonitorTool(DEFAULT_PROFILE.Monitor, io);
    const result = await tool.execute(
      'toolu_m',
      { command: 'tail -f app.log', description: '应用日志', timeout: 3600 },
      undefined,
      undefined,
      ctx,
    );
    expect(sent[0]?.method).toBe('exec/monitor');
    expect(sent[0]?.params).toMatchObject({
      command: 'tail -f app.log',
      description: '应用日志',
      timeoutMs: 3_600_000,
      origin: { tool: 'Monitor', toolCallId: 'toolu_m' },
    });
    expect(text(result)).toContain('Monitor started as task bg-1a1b2c3d4e5f.');
    expect(text(result)).toContain('30 minutes pass');
    expect(text(result)).toContain('The 60 minutes asked for are above the limit.');
    await expect(
      tool.execute(
        'toolu_m',
        { command: 'x', description: 'y', timeout: -1 },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('Invalid timeout');
  });
});

describe('Bash in the background', () => {
  it('asks Core for a background run and reports the task', async () => {
    const { io, sent } = fakeCore(() => ({
      result: {
        killed: false,
        cwd: '/w',
        task: { taskId: 'bg-2a1b2c3d4e5f', outputPath: '~/b.log', reason: 'requested' },
      },
    }));
    const tool = createBashTool({ io, presentation: DEFAULT_PROFILE.Bash });
    const result = await tool.execute(
      'toolu_b',
      { command: 'npm run dev', run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    expect(sent[0]?.params).toMatchObject({ command: 'npm run dev', background: true });
    expect(text(result)).toContain('running in the background as task bg-2a1b2c3d4e5f');
  });
});
