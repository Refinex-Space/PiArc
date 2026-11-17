// Harness Kit: how much of a tool result reaches the model (architecture section 6.15, "工具结果截断";
// the limits are in `TOOL_RESULT_LIMITS`, one place, overridable per registry).
//
// - One result: text longer than `maxResultChars` is kept whole in the session's temporary
//   directory (Core's `fs/spill`); the model gets the head and the tail (`previewChars` in all),
//   the number of characters left out, and the file's path to read the rest. Done when the tool
//   finishes (`tool_result`), so the session file and the transcript hold the preview too.
// - One message: the results answering one response together may hold `maxMessageChars`. Before
//   each model request (`context`), every run of tool results over that budget has its largest
//   results replaced by previews until it fits. The decision depends only on the results, and is
//   remembered by tool call id, so every request sends the same text (prompt caching) and a result
//   is spilled once.
// - `Read` is exempt from both: its output is already bounded (2000 lines or 50 KB) and points at
//   the next range itself; spilling it would only make the model read a file about a file.
//   Images pass unchanged.
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';

import type { CoreIo } from '../tools/core-io.js';

/** The limits, in UTF-16 code units of text. */
export interface ToolResultLimits {
  /** Longest result kept in the context as it is. */
  readonly maxResultChars: number;
  /** Most text the results answering one response may hold together. */
  readonly maxMessageChars: number;
  /** Size of a preview: half from the start, half from the end. */
  readonly previewChars: number;
}

export const TOOL_RESULT_LIMITS: ToolResultLimits = {
  maxResultChars: 50_000,
  maxMessageChars: 200_000,
  previewChars: 2_000,
};

export interface ToolResultBudgetOptions {
  /** Core I/O of the session: where results are spilled. */
  readonly io: CoreIo;
  /** Results of these tools pass unchanged (by the name the model calls them). */
  readonly isExempt: (toolName: string) => boolean;
  readonly limits?: ToolResultLimits;
}

type Content = Extract<AgentMessage, { role: 'toolResult' }>['content'];
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;

/** The extension that keeps a session's tool results within the limits. */
export function createToolResultBudget(options: ToolResultBudgetOptions): ExtensionFactory {
  const limits = options.limits ?? TOOL_RESULT_LIMITS;
  /** Results replaced for the message budget, by tool call id. */
  const replaced = new Map<string, Content>();
  return (pi: ExtensionAPI) => {
    pi.on('tool_result', async (event) => {
      if (options.isExempt(event.toolName)) {
        return undefined;
      }
      const text = textOf(event.content);
      if (text.length <= limits.maxResultChars) {
        return undefined;
      }
      return { content: await preview(options.io, event.toolCallId, event.content, limits) };
    });
    pi.on('context', async (event) => {
      let changed = false;
      const messages = [...event.messages];
      for (const run of resultRuns(messages)) {
        const budgeted = await budget(run, messages, options, limits, replaced);
        changed ||= budgeted;
      }
      return changed ? { messages } : undefined;
    });
  };
}

/** Indices of the runs of consecutive tool results (each run answers one response). */
function resultRuns(messages: readonly AgentMessage[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'toolResult') {
      run.push(index);
      return;
    }
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
}

/** Fits one run of results into the message budget; returns whether a message changed. */
async function budget(
  run: readonly number[],
  messages: AgentMessage[],
  options: ToolResultBudgetOptions,
  limits: ToolResultLimits,
  replaced: Map<string, Content>,
): Promise<boolean> {
  let changed = false;
  const results = run.map((index) => ({ index, message: messages[index] as ToolResultMessage }));
  // Earlier decisions first, so a request repeats the text of the previous one.
  for (const { index, message } of results) {
    const previous = replaced.get(message.toolCallId);
    if (previous !== undefined) {
      messages[index] = { ...message, content: previous };
      changed = true;
    }
  }
  const size = (index: number): number =>
    textOf((messages[index] as ToolResultMessage).content).length;
  let total = run.reduce((sum, index) => sum + size(index), 0);
  if (total <= limits.maxMessageChars) {
    return changed;
  }
  // Largest first; the tool call id breaks ties so the order never depends on timing.
  const candidates = results
    .filter(({ message }) => !options.isExempt(message.toolName))
    .filter(({ message }) => !replaced.has(message.toolCallId))
    .sort(
      (a, b) =>
        size(b.index) - size(a.index) || a.message.toolCallId.localeCompare(b.message.toolCallId),
    );
  for (const { index, message } of candidates) {
    if (total <= limits.maxMessageChars) {
      break;
    }
    const before = size(index);
    const content = await preview(options.io, message.toolCallId, message.content, limits);
    replaced.set(message.toolCallId, content);
    messages[index] = { ...message, content };
    total += textOf(content).length - before;
    changed = true;
  }
  return changed;
}

/** The content with its text replaced by a preview of the spilled whole; images stay. */
async function preview(
  io: CoreIo,
  toolCallId: string,
  content: Content,
  limits: ToolResultLimits,
): Promise<Content> {
  const text = textOf(content);
  let where: string;
  try {
    const path = await io.spill(toolCallId, text);
    where = `The whole result is saved in ${path}: read it in parts with Read (offset and limit) or search it with Grep.`;
  } catch (error) {
    where = `The whole result could not be saved (${error instanceof Error ? error.message : String(error)}).`;
  }
  const notice =
    `[This result has ${String(text.length)} characters, too many for the context; only its ` +
    `start and end are shown. ${where}]`;
  const images = content.filter((block) => block.type === 'image');
  return [
    { type: 'text', text: `${notice}\n\n${headAndTail(text, limits.previewChars)}` },
    ...images,
  ];
}

/** The first and last `size / 2` characters of `text`, with the number left out between them. */
export function headAndTail(text: string, size: number): string {
  const half = Math.floor(size / 2);
  if (text.length <= size) {
    return text;
  }
  let headEnd = half;
  // Never cut a surrogate pair.
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  let tailStart = text.length - half;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n\n[… ${String(omitted)} characters left out …]\n\n${text.slice(tailStart)}`;
}

function textOf(content: Content): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
