// `KillShell` and `Monitor` (architecture section 6.11, T32, ADR-0049). Core holds the
// processes: KillShell asks Core's task manager to stop a task of this session or of its
// subagents (`exec/background/kill`), Monitor asks Core to run a command whose new output
// lines come back as `monitorOutput` reminders (`exec/monitor`). Monitor's command is checked
// like Bash's (rules, analysis, `Bash` hooks) by the permission preflight before it runs.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { AhpError } from '../protocol/errors.js';
import type { CoreIo } from '../tools/core-io.js';
import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import { monitorStarted, taskAlreadyEnded, taskStopped, taskUnknown } from './prompts/tasks.js';

const killSchema = Type.Object({
  shell_id: Type.String({
    minLength: 1,
    description: 'The id of the background task to stop (bg-…)',
  }),
});

const monitorSchema = Type.Object({
  command: Type.String({
    minLength: 1,
    description: 'The command to watch; it should keep printing lines (tail -f, a polling loop)',
  }),
  description: Type.String({
    minLength: 1,
    description: 'A few words on what it watches; the background task list shows them',
  }),
  timeout: Type.Optional(
    Type.Number({ description: 'How long it may run, in seconds; 300 when omitted, at most 1800' }),
  ),
});

/** What the transcript shows about a stopped task (`details.task`). */
export interface TaskToolDetails {
  readonly task: { readonly taskId: string; readonly status?: string };
}

export function createKillShellTool(presentation: ToolPresentation, io: CoreIo): ToolDefinition {
  return defineTool<typeof killSchema, TaskToolDetails>({
    ...presentationOf(presentation),
    parameters: killSchema,
    async execute(_toolCallId, params) {
      const id = params.shell_id.trim();
      try {
        const stopped = await io.killTask(id);
        const text = stopped.stopped
          ? taskStopped(id, stopped.title, stopped.outputPath, stopped.tail)
          : taskAlreadyEnded(id, stopped.status, stopped.tail);
        return {
          content: [{ type: 'text', text }],
          details: { task: { taskId: id, status: stopped.status } },
        };
      } catch (error) {
        if (error instanceof AhpError && error.kind === 'notFound') {
          throw new Error(taskUnknown(id), { cause: error });
        }
        throw error;
      }
    },
  });
}

export function createMonitorTool(presentation: ToolPresentation, io: CoreIo): ToolDefinition {
  return defineTool<typeof monitorSchema, TaskToolDetails>({
    ...presentationOf(presentation),
    parameters: monitorSchema,
    async execute(toolCallId, params) {
      const timeoutMs = timeoutMsOf(params.timeout);
      const started = await io.monitor(params.command, params.description, timeoutMs, {
        tool: 'Monitor',
        toolCallId,
      });
      return {
        content: [
          {
            type: 'text',
            text: monitorStarted(
              started.taskId,
              started.outputPath,
              started.timeoutMs,
              started.requestedTimeoutMs,
            ),
          },
        ],
        details: { task: { taskId: started.taskId } },
      };
    },
  });
}

/** Seconds to milliseconds, validated like Bash's timeout. */
function timeoutMsOf(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  return Math.max(1, Math.min(Math.round(timeout * 1000), Number.MAX_SAFE_INTEGER));
}
