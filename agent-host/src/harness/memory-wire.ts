import type { FrozenSystem } from './prompts/system.js';
import { isObject } from '../runtime/items.js';
import { HOOK_MARKER } from './hooks.js';
import { REMINDER_MARKER } from './reminders.js';

export const MEMORY_MARKER = '[PiArc memory]';

/** Pi 1.5.2 converts a custom message to a separate user message. Anthropic also represents
 * tool results as user messages. Deliver the notice (memory, hook context or a reminder) as a sibling
 * text block on that wire, after any tool results; keep the original messages and cache
 * metadata in the session. */
export function anthropicMemoryPayload(
  payload: unknown,
  frozen?: FrozenSystem,
  forkCallId?: string,
): unknown {
  if (!isObject(payload) || !Array.isArray(payload.messages)) return undefined;
  const messages: unknown[] = [];
  let group: Record<string, unknown>[] = [];

  function flush(): void {
    // A fork's first task follows the inherited tool results. On the Anthropic wire both
    // are user blocks of the same turn, with tool results ahead of the task.
    const forkBoundary =
      forkCallId !== undefined &&
      group[0] !== undefined &&
      blocks(group[0].content).some(
        (block) =>
          isObject(block) && block.type === 'tool_result' && block.tool_use_id === forkCallId,
      );
    if (
      group.length > 1 &&
      (forkBoundary ||
        group.some((message) =>
          blocks(message.content).some(
            (block) =>
              isObject(block) &&
              block.type === 'text' &&
              typeof block.text === 'string' &&
              isNotice(block.text),
          ),
        ))
    ) {
      messages.push({ ...group[0], content: group.flatMap((message) => blocks(message.content)) });
    } else {
      messages.push(...group);
    }
    group = [];
  }

  for (const message of payload.messages as unknown[]) {
    if (isObject(message) && message.role === 'user') {
      group.push(message);
    } else {
      flush();
      messages.push(message);
    }
  }
  flush();
  const system = splitCachedSystem(payload, frozen);
  if (messages.length === payload.messages.length && system === undefined) return undefined;
  return { ...payload, messages, ...(system === undefined ? {} : { system }) };
}

/** Text that PiArc adds for the model: memory, hook context or a reminder. */
function isNotice(text: string): boolean {
  return [MEMORY_MARKER, HOOK_MARKER, REMINDER_MARKER].some((marker) =>
    text.startsWith(marker + '\n'),
  );
}

function blocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: content }];
}

/** Preserve cache options from the locked SDK, including its long-lived TTL where supported.
 * With all four breakpoints already spoken for, retain the existing provider layout. */
function splitCachedSystem(
  payload: Record<string, unknown>,
  frozen: FrozenSystem | undefined,
): unknown[] | undefined {
  if (
    !frozen ||
    !Array.isArray(payload.system) ||
    frozen.cacheBoundary <= 0 ||
    !frozen.text.startsWith('<project_context>', frozen.cacheBoundary)
  )
    return;
  const system: unknown[] = payload.system;
  const index = system.findIndex(
    (block) =>
      isObject(block) &&
      block.type === 'text' &&
      block.text === frozen.text &&
      isObject(block.cache_control) &&
      block.cache_control.type === 'ephemeral',
  );
  const block = system[index];
  if (!isObject(block)) return;
  let count =
    Number(Object.hasOwn(payload, 'cache_control')) +
    cacheMarkers(system) +
    cacheMarkers(payload.tools);
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (isObject(message)) count += cacheMarkers(message.content);
  }
  if (count >= 4) return;
  const parts = [...system];
  parts.splice(
    index,
    1,
    { ...block, text: frozen.text.slice(0, frozen.cacheBoundary) },
    { ...block, text: frozen.text.slice(frozen.cacheBoundary) },
  );
  return parts;
}

function cacheMarkers(values: unknown): number {
  if (!Array.isArray(values)) return 0;
  let count = 0;
  for (const block of values) {
    if (!isObject(block)) continue;
    if (Object.hasOwn(block, 'cache_control')) count++;
    if (block.type === 'tool_result') count += cacheMarkers(block.content);
  }
  return count;
}
