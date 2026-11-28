// What the model reads from KillShell and Monitor (T32, ADR-0049). PiArc's own text
// (ADR-0006); `scripts/dev/check-prompt-originality.mjs` checks it with the other prompts.
import type { TaskStatus } from '@piarc/protocol';

/** KillShell stopped task `id`; `tail` is the end of its output. */
export function taskStopped(
  id: string,
  title: string,
  path: string | undefined,
  tail: string,
): string {
  return [
    `Task ${id} (${title}) was stopped together with every process it started.`,
    ...(path === undefined ? [] : [`Its output file stays at ${path}.`]),
    ...(tail.length === 0 ? ['It had printed nothing.'] : ['Its last lines:', tail]),
  ].join('\n');
}

/** KillShell found task `id` already over. */
export function taskAlreadyEnded(id: string, status: TaskStatus, tail: string): string {
  return [
    `Task ${id} had already ended (${status}); nothing was stopped.`,
    ...(tail.length === 0 ? [] : ['Its last lines:', tail]),
  ].join('\n');
}

/** KillShell got an id this session does not own. */
export function taskUnknown(id: string): string {
  return (
    `There is no background task ${id} in this session. Use the id a background command, ` +
    'Monitor or background subagent of this session reported.'
  );
}

/** A Monitor started. */
export function monitorStarted(
  id: string,
  path: string,
  timeoutMs: number,
  requestedTimeoutMs: number | undefined,
): string {
  const minutes = (ms: number): string => {
    const value = ms / 60_000;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };
  return [
    `Monitor started as task ${id}. Each new line of its output reaches you as a note before ` +
      'your next step, or wakes the session when it is idle; long bursts arrive shortened, ' +
      `with the full output in ${path}.`,
    `It runs until its command ends, ${minutes(timeoutMs)} minutes pass, or you stop it with ` +
      `KillShell (shell_id ${id}).` +
      (requestedTimeoutMs === undefined
        ? ''
        : ` The ${minutes(requestedTimeoutMs)} minutes asked for are above the limit.`),
  ].join('\n');
}
