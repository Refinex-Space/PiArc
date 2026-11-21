// `Bash` and `PowerShell`: PiArc's command tools (architecture section 6.11, T17, ADR-0028).
//
// Core does the work of a command (`exec/run`): the shell, the working directory carried from
// one bash command to the next, the timeout (2 minutes by default, at most 10; a command that
// reaches it moves to the background as a task, T32), `run_in_background`, stopping the whole
// process tree, the output budget with the full text saved to the session's temporary
// directory, and what the exit code means (`grep` exiting 1 found nothing). These tools keep
// Pi's parameters (`command`, `timeout` in seconds), show the output live while it arrives, and
// turn Core's structured result into the text the model reads and the details the
// `commandExecution` item carries (`details.commandExecution`, read by `items.ts`).
//
// Pi's own bash tool is not used: it accumulates and truncates output itself (its last 2000
// lines or 50 KB, written to a file by the Agent Host) and has no timeout default, cwd carry-over
// or exit code meanings; Core holds the output and the process instead.
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CommandExecutionInfo, CwdReset, ExecShell } from '@piarc/protocol';
import { Type } from 'typebox';

import { isAborted, type CommandResult, type Origin } from './core-io.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { sandboxNote } from './sandbox-report.js';

const commandParameters = {
  command: Type.String({ description: 'The command line to run' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds; 120 when omitted, at most 600' }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'Start the command as a background task and return at once (for servers, watchers and ' +
        'long builds); you are told when it ends',
    }),
  ),
};

const powerShellSchema = Type.Object(commandParameters);

// PiArc's own parameter (T33, ADR-0050): the command runs in a PiArc terminal whose screen the
// model reads as text; it implies `run_in_background`. `dangerouslyDisableSandbox` (T39) has
// Claude Code's name, so hooks see the same `tool_input`; Core asks the user about every such
// call and ignores it while the sandbox is off.
const bashSchema = Type.Object({
  ...commandParameters,
  dangerouslyDisableSandbox: Type.Optional(
    Type.Boolean({
      description:
        "Run this command outside PiArc's sandbox. Use it only after the same command failed " +
        'because the sandbox refused a path or a host; the user must approve every such run',
    }),
  ),
  terminal: Type.Optional(
    Type.Boolean({
      description:
        'Run the command in a PiArc terminal (a real terminal the user can open) as a ' +
        'background task: for full-screen or interactive programs and servers whose screen ' +
        'matters. Implies run_in_background; the result names a file with the screen as text',
    }),
  ),
});

/** What the live view keeps of the output while the command runs (items keep as much). */
export const LIVE_OUTPUT_CHARS = 64 * 1024;

/** Least time between two live updates. */
export const LIVE_UPDATE_MS = 100;

/** The details of a command tool's result. */
export interface ShellToolDetails {
  readonly commandExecution: CommandExecutionInfo;
}

type ShellTool = 'Bash' | 'PowerShell';

export function createBashTool(setup: ToolSetup): ToolDefinition {
  return defineTool<typeof bashSchema, ShellToolDetails | undefined>({
    ...presentationOf(setup.presentation),
    parameters: bashSchema,
    execute: (toolCallId, params, signal, onUpdate) =>
      runShell(setup, 'Bash', 'bash', toolCallId, params, signal, onUpdate),
  });
}

export function createPowerShellTool(setup: ToolSetup): ToolDefinition {
  return defineTool<typeof powerShellSchema, ShellToolDetails | undefined>({
    ...presentationOf(setup.presentation),
    parameters: powerShellSchema,
    execute: (toolCallId, params, signal, onUpdate) =>
      runShell(setup, 'PowerShell', 'powershell', toolCallId, params, signal, onUpdate),
  });
}

interface ShellParams {
  readonly command: string;
  readonly timeout?: number;
  readonly run_in_background?: boolean;
  readonly terminal?: boolean;
}

async function runShell(
  { io }: ToolSetup,
  tool: ShellTool,
  shell: ExecShell,
  toolCallId: string,
  params: ShellParams,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined,
): Promise<AgentToolResult<ShellToolDetails | undefined>> {
  if (isAborted(signal)) {
    throw new Error('Command aborted');
  }
  const timeoutMs = timeoutMsOf(params.timeout);
  const live = new LiveView(onUpdate);
  const origin: Origin = { tool, toolCallId };
  const terminal = params.terminal === true;
  const background = terminal || params.run_in_background === true;
  const { outcome, kill } = io.run(
    {
      command: params.command,
      shell,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(background ? { background } : {}),
      ...(terminal ? { terminal } : {}),
    },
    (_stream, data, skipped) => {
      live.append(data, skipped);
    },
    origin,
  );
  const stop = (): void => {
    // A failed kill means the command already ended or the connection is gone; either
    // way `outcome` settles on its own (Core also stops a turn's commands on abort).
    kill().catch(() => undefined);
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await outcome;
    return shellResult(result, isAborted(signal), terminal);
  } finally {
    live.close();
    signal?.removeEventListener('abort', stop);
  }
}

/** The model's text, the error flag and the item details of a finished command. */
export function shellResult(
  result: CommandResult,
  aborted: boolean,
  terminal = false,
): AgentToolResult<ShellToolDetails | undefined> & { isError: boolean } {
  const execution = executionInfo(result);
  if (result.task !== undefined && !aborted) {
    // It runs on as a background task (T32): nothing failed.
    return {
      content: [{ type: 'text', text: taskText(result, terminal) }],
      details: execution === undefined ? undefined : { commandExecution: execution },
      isError: false,
    };
  }
  const failed =
    aborted ||
    result.killed ||
    result.timedOut ||
    (result.outcome === undefined ? result.exitCode !== 0 : result.outcome === 'failure');
  const note = sandboxNote(result.sandbox, failed && !aborted && !result.killed);
  const text = modelText(result, aborted);
  return {
    content: [{ type: 'text', text: note.length === 0 ? text : `${text}\n\n${note}` }],
    details: execution === undefined ? undefined : { commandExecution: execution },
    isError: failed,
  };
}

/**
 * The output the model reads, followed by what it needs to know about how the command ended.
 * Where Pi's bash tool reports the same thing, the words are Pi's ("Command exited with code
 * 3", "Command timed out after 120 seconds", "Command aborted"), joined to the output the same
 * way, so a model used to Pi reads the same text.
 */
export function modelText(result: CommandResult, aborted: boolean): string {
  const notes: string[] = [];
  const seconds = (ms: number | undefined): string => String(Math.round((ms ?? 0) / 1000));
  const stopped = aborted || result.killed || result.timedOut;
  if (aborted || result.killed) {
    notes.push('Command aborted');
  } else if (result.timedOut) {
    notes.push(
      `Command timed out after ${seconds(result.timeoutMs)} seconds; it and every process it ` +
        'started were stopped.',
    );
  } else if (result.exitCode !== undefined && result.exitCode !== 0) {
    notes.push(
      result.outcome === 'success' && result.meaning !== undefined
        ? `Command exited with code ${String(result.exitCode)} (${result.meaning}; not an error)`
        : `Command exited with code ${String(result.exitCode)}`,
    );
  } else if (result.exitCode === undefined && result.signal !== undefined) {
    notes.push(`Command terminated by signal ${String(result.signal)}`);
  }
  if (result.requestedTimeoutMs !== undefined) {
    notes.push(
      `The requested timeout of ${seconds(result.requestedTimeoutMs)} seconds is above the ` +
        `maximum; the command ran with ${seconds(result.timeoutMs)} seconds.`,
    );
  }
  if (result.cwdReset !== undefined) {
    notes.push(cwdNote(result.cwdReset));
  }
  const body = outputText(result);
  const shown = body.length > 0 || stopped ? body : '(no output)';
  const status = notes.join('\n');
  if (status.length === 0) {
    return shown;
  }
  return shown.length === 0 ? status : `${shown}\n\n${status}`;
}

/** What the model reads about a command that became a background task (T32). */
function taskText(result: CommandResult, terminal: boolean): string {
  const task = result.task;
  if (task === undefined) return '';
  const after =
    `Its output goes to ${task.outputPath}; read it with Read. You will be told when it ends; ` +
    `stop it earlier with KillShell (shell_id ${task.taskId}).`;
  if (task.reason === 'timeout') {
    const seconds = String(Math.round((result.timeoutMs ?? 0) / 1000));
    return (
      `The command was still running after its timeout of ${seconds} seconds, so it moved to ` +
      `the background as task ${task.taskId} instead of being stopped; it keeps running. ` +
      `What it printed so far is at the start of its output file. ${after}`
    );
  }
  if (terminal) {
    return (
      `The command is running in a PiArc terminal as background task ${task.taskId}. The ` +
      `terminal's screen and scrollback, as text, are in ${task.outputPath}; read it with Read ` +
      `(Core keeps it current). You will be told when the command finishes; the terminal ` +
      `stays open after that, and KillShell (shell_id ${task.taskId}) closes it.`
    );
  }
  return `The command is running in the background as task ${task.taskId}. ${after}`;
}

function outputText(result: CommandResult): string {
  const output = result.output;
  if (output === undefined) {
    return '';
  }
  if (output.tail === undefined || output.tail === null) {
    return output.head;
  }
  const omitted = String(output.omittedChars ?? 0);
  const total = String(output.totalChars);
  const saved =
    output.fullOutputPath === undefined || output.fullOutputPath === null
      ? `The full output (${total} characters) could not be saved` +
        (output.saveError ? `: ${output.saveError}` : '') +
        '.'
      : `The full output (${total} characters) is in ${output.fullOutputPath}; ` +
        'read it with Read, in parts with offset and limit.';
  const head = output.head.endsWith('\n') ? output.head : `${output.head}\n`;
  return `${head}\n[... ${omitted} characters omitted. ${saved}]\n\n${output.tail}`;
}

function cwdNote(reset: CwdReset): string {
  return reset.reason === 'outsideWorkspace'
    ? `The shell ended in ${reset.endedIn}, outside the workspace; the next command starts in ` +
        `${reset.resetTo}.`
    : `The directory ${reset.endedIn} no longer exists; the command ran in ${reset.resetTo}.`;
}

/** The `commandExecution` details of a result; undefined when Core did not report them. */
function executionInfo(result: CommandResult): CommandExecutionInfo | undefined {
  if (result.task !== undefined && result.cwd !== undefined) {
    return {
      cwd: result.cwd,
      outcome: 'success',
      durationMs: result.durationMs ?? 0,
      timedOut: result.timedOut,
      timeoutMs: result.timeoutMs ?? 0,
      truncated: false,
      task: result.task,
      ...(result.cwdReset === undefined ? {} : { cwdReset: result.cwdReset }),
    };
  }
  if (
    result.cwd === undefined ||
    result.durationMs === undefined ||
    result.timeoutMs === undefined ||
    result.outcome === undefined
  ) {
    return undefined;
  }
  const output = result.output;
  return {
    cwd: result.cwd,
    outcome: result.outcome,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    timeoutMs: result.timeoutMs,
    truncated: output?.tail !== undefined && output.tail !== null,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(result.meaning === undefined ? {} : { meaning: result.meaning }),
    ...(output?.fullOutputPath === undefined || output.fullOutputPath === null
      ? {}
      : { fullOutputPath: output.fullOutputPath }),
    ...(result.cwdReset === undefined ? {} : { cwdReset: result.cwdReset }),
  };
}

/** `details.commandExecution` as stored in a session file: validated, since the file is input. */
export function parseExecutionInfo(value: unknown): CommandExecutionInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { cwd, outcome, durationMs, timedOut, timeoutMs, truncated } = value;
  if (
    typeof cwd !== 'string' ||
    (outcome !== 'success' && outcome !== 'failure') ||
    !isCount(durationMs) ||
    typeof timedOut !== 'boolean' ||
    !isCount(timeoutMs) ||
    typeof truncated !== 'boolean'
  ) {
    return undefined;
  }
  const info: CommandExecutionInfo = {
    cwd: cwd.toWellFormed(),
    outcome,
    durationMs,
    timedOut,
    timeoutMs,
    truncated,
  };
  const exitCode = isInteger(value.exitCode) ? value.exitCode : undefined;
  const signal = isInteger(value.signal) ? value.signal : undefined;
  const reset = value.cwdReset;
  const task = value.task;
  return {
    ...info,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(typeof value.meaning === 'string' ? { meaning: value.meaning } : {}),
    ...(typeof value.fullOutputPath === 'string'
      ? { fullOutputPath: value.fullOutputPath.toWellFormed() }
      : {}),
    ...(isRecord(reset) &&
    typeof reset.endedIn === 'string' &&
    typeof reset.resetTo === 'string' &&
    (reset.reason === 'outsideWorkspace' || reset.reason === 'missing')
      ? {
          cwdReset: {
            endedIn: reset.endedIn.toWellFormed(),
            resetTo: reset.resetTo.toWellFormed(),
            reason: reset.reason,
          },
        }
      : {}),
    ...(isRecord(task) &&
    typeof task.taskId === 'string' &&
    typeof task.outputPath === 'string' &&
    (task.reason === 'requested' || task.reason === 'timeout')
      ? {
          task: {
            taskId: task.taskId.toWellFormed(),
            outputPath: task.outputPath.toWellFormed(),
            reason: task.reason,
          },
        }
      : {}),
  };
}

/** The timeout in milliseconds Core gets, with Pi's validation of the seconds. */
function timeoutMsOf(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  return Math.max(1, Math.min(Math.round(timeout * 1000), Number.MAX_SAFE_INTEGER));
}

/** The end of the output so far, sent as tool updates at most every `LIVE_UPDATE_MS`. */
class LiveView {
  readonly #onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined;
  #text = '';
  #pending = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #last = 0;

  constructor(onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined) {
    this.#onUpdate = onUpdate;
  }

  append(data: string, skipped: number): void {
    if (this.#onUpdate === undefined) {
      return;
    }
    const gap = skipped > 0 ? `\n[... ${String(skipped)} bytes not shown ...]\n` : '';
    this.#text = (this.#text + gap + data).slice(-LIVE_OUTPUT_CHARS);
    this.#pending = true;
    if (this.#timer !== undefined) {
      return;
    }
    const wait = this.#last + LIVE_UPDATE_MS - Date.now();
    if (wait <= 0) {
      this.#flush();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, wait);
  }

  /** Sends what is still pending; the command has ended. */
  close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#pending) {
      this.#flush();
    }
  }

  #flush(): void {
    this.#pending = false;
    this.#last = Date.now();
    this.#onUpdate?.({ content: [{ type: 'text', text: this.#text }], details: undefined });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}
