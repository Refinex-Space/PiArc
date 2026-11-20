import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { CoreIo, ExecOutputRouter, type CommandResult } from './core-io.js';
import { createToolSet } from './index.js';
import { DEFAULT_PROFILE } from './profile.js';
import { createBashTool, modelText, parseExecutionInfo, shellResult } from './shell.js';

interface Sent {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A CoreIo whose `exec/run` streams `chunks` and then answers `result`. */
function fakeCore(
  result: object,
  chunks: { data: string; skipped?: number }[] = [],
): { io: CoreIo; sent: Sent[] } {
  const sent: Sent[] = [];
  const execOutput = new ExecOutputRouter();
  const bridge: CoreBridge = new CoreBridge((message) => {
    const request = message as Sent;
    sent.push(request);
    queueMicrotask(() => {
      if (request.method === 'exec/run') {
        chunks.forEach((chunk, i) => {
          execOutput.deliver({
            requestId: request.params.requestId,
            stream: 'stdout',
            seq: i + 1,
            data: chunk.data,
            ...(chunk.skipped === undefined ? {} : { skipped: chunk.skipped }),
          });
        });
      }
      bridge.handleResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'exec/run' ? result : { killed: true },
      });
    });
  });
  return {
    sent,
    io: new CoreIo({
      bridge,
      sessionId: 'sess-1',
      execOutput,
      readBlob: () => Promise.reject(new Error('no blobs')),
    }),
  };
}

const base: CommandResult = {
  exitCode: 0,
  signal: undefined,
  killed: false,
  timedOut: false,
  timeoutMs: 120_000,
  requestedTimeoutMs: undefined,
  durationMs: 15,
  outcome: 'success',
  meaning: undefined,
  cwd: '/w/项目',
  cwdReset: undefined,
  output: { head: 'hello\n', totalChars: 6 },
  task: undefined,
};

describe('modelText', () => {
  it('gives short output whole and says nothing more after success', () => {
    expect(modelText(base, false)).toBe('hello\n');
    expect(modelText({ ...base, output: { head: '', totalChars: 0 } }, false)).toBe('(no output)');
  });

  it('names exit codes, their meaning, timeouts and cut timeouts', () => {
    expect(modelText({ ...base, exitCode: 1, meaning: 'no matches' }, false)).toBe(
      'hello\n\n\nCommand exited with code 1 (no matches; not an error)',
    );
    expect(modelText({ ...base, exitCode: 2, outcome: 'failure' }, false)).toBe(
      'hello\n\n\nCommand exited with code 2',
    );
    expect(
      modelText(
        { ...base, exitCode: 3, outcome: 'failure', output: { head: '', totalChars: 0 } },
        false,
      ),
    ).toBe('(no output)\n\nCommand exited with code 3');
    const timedOut = modelText(
      {
        ...base,
        exitCode: undefined,
        signal: 15,
        timedOut: true,
        outcome: 'failure',
        timeoutMs: 600_000,
        requestedTimeoutMs: 900_000,
      },
      false,
    );
    expect(timedOut).toContain('hello\n\n\nCommand timed out after 600 seconds');
    expect(timedOut).toContain('The requested timeout of 900 seconds is above the maximum');
    expect(modelText({ ...base, killed: true, outcome: 'failure' }, true)).toContain(
      'Command aborted',
    );
  });

  it('shows the start and end of long output and where the full text is', () => {
    const text = modelText(
      {
        ...base,
        output: {
          head: 'first\n',
          tail: 'last\n',
          totalChars: 50_000,
          omittedChars: 49_989,
          fullOutputPath: '~/data/tool-results/toolu_1.txt',
        },
      },
      false,
    );
    expect(text).toBe(
      'first\n\n[... 49989 characters omitted. The full output (50000 characters) is in ' +
        '~/data/tool-results/toolu_1.txt; read it with Read, in parts with offset and limit.]\n\nlast\n',
    );
  });

  it('explains a reset working directory', () => {
    const text = modelText(
      {
        ...base,
        cwdReset: { endedIn: '/tmp', resetTo: '/w/项目', reason: 'outsideWorkspace' },
      },
      false,
    );
    expect(text).toBe(
      'hello\n\n\nThe shell ended in /tmp, outside the workspace; the next command starts in /w/项目.',
    );
  });
});

describe('shellResult', () => {
  it('fails by outcome, not by exit code, and carries the execution details', () => {
    const grep = shellResult({ ...base, exitCode: 1, meaning: 'no matches' }, false);
    expect(grep.isError).toBe(false);
    expect(grep.details?.commandExecution).toEqual({
      cwd: '/w/项目',
      exitCode: 1,
      outcome: 'success',
      meaning: 'no matches',
      durationMs: 15,
      timedOut: false,
      timeoutMs: 120_000,
      truncated: false,
    });
    expect(shellResult({ ...base, exitCode: 2, outcome: 'failure' }, false).isError).toBe(true);
    expect(shellResult({ ...base, timedOut: true, outcome: 'failure' }, false).isError).toBe(true);
    expect(shellResult(base, true).isError).toBe(true);
  });

  it('tells a command that runs on as a background task, asked for or by its timeout', () => {
    const task = {
      taskId: 'bg-0a1b2c3d4e5f',
      outputPath: '~/d/sessions/s/tasks/bg-0a1b2c3d4e5f.log',
    };
    const asked = shellResult(
      {
        ...base,
        exitCode: undefined,
        outcome: undefined,
        output: undefined,
        durationMs: undefined,
        timeoutMs: undefined,
        task: { ...task, reason: 'requested' },
      },
      false,
    );
    expect(asked.isError).toBe(false);
    const text = asked.content[0]?.type === 'text' ? asked.content[0].text : '';
    expect(text).toContain('running in the background as task bg-0a1b2c3d4e5f');
    expect(text).toContain(task.outputPath);
    expect(text).toContain('KillShell');
    expect(asked.details?.commandExecution.task).toEqual({ ...task, reason: 'requested' });
    const moved = shellResult(
      {
        ...base,
        exitCode: undefined,
        outcome: undefined,
        output: undefined,
        timedOut: true,
        timeoutMs: 2_000,
        durationMs: 2_004,
        task: { ...task, reason: 'timeout' },
      },
      false,
    );
    expect(moved.isError).toBe(false);
    const movedText = moved.content[0]?.type === 'text' ? moved.content[0].text : '';
    expect(movedText).toContain('still running after its timeout of 2 seconds');
    expect(movedText).toContain('instead of being stopped');
    const stored: unknown = JSON.parse(JSON.stringify(moved.details?.commandExecution));
    expect(parseExecutionInfo(stored)).toEqual(moved.details?.commandExecution);
  });

  it('tells a command that runs in a PiArc terminal where its screen is (T33)', () => {
    const task = {
      taskId: 'bg-0a1b2c3d4e5f',
      outputPath: '~/d/sessions/s/tasks/bg-0a1b2c3d4e5f.log',
      reason: 'requested' as const,
    };
    const started = shellResult(
      {
        ...base,
        exitCode: undefined,
        outcome: undefined,
        output: undefined,
        durationMs: undefined,
        timeoutMs: undefined,
        task,
      },
      false,
      true,
    );
    expect(started.isError).toBe(false);
    const text = started.content[0]?.type === 'text' ? started.content[0].text : '';
    expect(text).toContain('in a PiArc terminal as background task bg-0a1b2c3d4e5f');
    expect(text).toContain(task.outputPath);
    expect(text).toContain('stays open');
    expect(text).toContain('KillShell');
  });

  it('round-trips the details through a session file', () => {
    const details = shellResult({ ...base, signal: 9, exitCode: undefined }, false).details;
    const stored: unknown = JSON.parse(JSON.stringify(details?.commandExecution));
    expect(parseExecutionInfo(stored)).toEqual(details?.commandExecution);
    expect(parseExecutionInfo({ cwd: '/w' })).toBeUndefined();
  });
});

describe('the Bash tool', () => {
  const ctx = { cwd: '/w' } as ExtensionToolContext;

  it('sends the command, shell and timeout to Core and shows output live', async () => {
    vi.useFakeTimers();
    try {
      const { io, sent } = fakeCore(base, [
        { data: 'part 1\n' },
        { data: 'part 9\n', skipped: 4096 },
      ]);
      const tool = createBashTool({ io, presentation: DEFAULT_PROFILE.Bash });
      const updates: string[] = [];
      const running = tool.execute(
        'toolu_1',
        { command: 'make', timeout: 1.5 },
        undefined,
        (partial) => {
          const part = partial.content[0];
          updates.push(part?.type === 'text' ? part.text : '');
        },
        ctx,
      );
      await vi.advanceTimersByTimeAsync(200);
      const result = await running;
      expect(sent[0]?.method).toBe('exec/run');
      expect(sent[0]?.params).toMatchObject({
        command: 'make',
        shell: 'bash',
        timeoutMs: 1500,
        origin: { tool: 'Bash', toolCallId: 'toolu_1' },
      });
      expect(sent[0]?.params).not.toHaveProperty('cwd');
      expect(result.content).toEqual([{ type: 'text', text: 'hello\n' }]);
      // The first chunk shows at once; the rest is sent when the command ends.
      expect(updates).toEqual(['part 1\n', 'part 1\n\n[... 4096 bytes not shown ...]\npart 9\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects timeouts that are not positive, as Pi's bash does", async () => {
    const { io } = fakeCore(base);
    const tool = createBashTool({ io, presentation: DEFAULT_PROFILE.Bash });
    await expect(
      tool.execute('toolu_2', { command: 'x', timeout: 0 }, undefined, undefined, ctx),
    ).rejects.toThrow('Invalid timeout');
  });
});

describe('createToolSet', () => {
  it('offers Bash and PowerShell by the shells Core found', () => {
    const { io } = fakeCore(base);
    const names = (bash: boolean, powershell: boolean): string[] =>
      createToolSet(io, DEFAULT_PROFILE, { bash, powershell }).map((tool) => tool.name);
    expect(names(true, false)).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
    expect(names(true, true)).toEqual([
      'Read',
      'Write',
      'Edit',
      'Bash',
      'PowerShell',
      'Glob',
      'Grep',
    ]);
    // Windows without Git Bash.
    expect(names(false, true)).toEqual(['Read', 'Write', 'Edit', 'PowerShell', 'Glob', 'Grep']);
  });
});
