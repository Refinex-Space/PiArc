// Builders shared by the live projection (projector.ts) and the history projection
// (history.ts): one canonical tool name maps to one item type, and item fields are bounded the
// same way in both (architecture section 5.3).
import type { CompactionReason, Item, ItemStatus, TurnUsage } from '@piarc/protocol';

import { wellFormedJson } from '../protocol/well-formed.js';

/** The most UTF-16 code units of tool output an item carries; longer output keeps its end. */
export const MAX_ITEM_OUTPUT = 64 * 1024;

/** Tool arguments larger than this (as JSON) are replaced by a note in items. */
export const MAX_ITEM_ARGUMENTS = 256 * 1024;

/** Tool arguments nested deeper than this are replaced by a note (frames stop at 127, I09). */
export const MAX_ARGUMENT_DEPTH = 64;

/** Canonical tools whose calls are `commandExecution` items. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
/** Canonical tools whose calls are `fileChange` items. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export type ToolItemType =
  'commandExecution' | 'fileChange' | 'mcpToolCall' | 'subagent' | 'webFetch' | 'dynamicToolCall';

/** The item type of a canonical tool name. */
export function toolItemType(tool: string): ToolItemType {
  if (COMMAND_TOOLS.has(tool)) {
    return 'commandExecution';
  }
  if (FILE_TOOLS.has(tool)) {
    return 'fileChange';
  }
  if (splitMcpName(tool) !== undefined) {
    return 'mcpToolCall';
  }
  if (tool === 'Agent') {
    return 'subagent';
  }
  return tool === 'WebFetch' ? 'webFetch' : 'dynamicToolCall';
}

/** `mcp__<server>__<tool>` split into server and tool. */
function splitMcpName(tool: string): { server: string; serverTool: string } | undefined {
  if (!tool.startsWith('mcp__')) {
    return undefined;
  }
  const rest = tool.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0 || separator + 2 >= rest.length) {
    return undefined;
  }
  return { server: rest.slice(0, separator), serverTool: rest.slice(separator + 2) };
}

/** A tool call as an item of the type its canonical name maps to. */
export function toolItem(
  itemId: string,
  status: ItemStatus,
  tool: string,
  args: Record<string, unknown>,
  output: string | undefined,
): Item {
  const common = {
    itemId,
    status,
    tool,
    arguments: boundArguments(args),
    ...(output === undefined ? {} : { output: boundOutput(output) }),
  };
  const text = (name: string): string => {
    const value = args[name];
    return typeof value === 'string' ? value.toWellFormed() : '';
  };
  switch (toolItemType(tool)) {
    case 'commandExecution':
      return { type: 'commandExecution', ...common, command: text('command') };
    case 'fileChange':
      return {
        type: 'fileChange',
        ...common,
        path: text('path') || text('file_path') || text('notebook_path'),
      };
    case 'mcpToolCall': {
      const names = splitMcpName(tool) ?? { server: '', serverTool: tool };
      return { type: 'mcpToolCall', ...common, ...names };
    }
    case 'subagent': {
      const description = text('description');
      return { type: 'subagent', ...common, ...(description === '' ? {} : { description }) };
    }
    case 'webFetch':
      return { type: 'webFetch', ...common, url: text('url') };
    case 'dynamicToolCall':
      return { type: 'dynamicToolCall', ...common };
  }
}

export function userMessage(itemId: string, text: string): Item {
  return { type: 'userMessage', itemId, status: 'completed', text: text.toWellFormed() };
}

export function agentMessage(itemId: string, status: ItemStatus, text: string): Item {
  return { type: 'agentMessage', itemId, status, text };
}

export function reasoning(itemId: string, status: ItemStatus, text: string): Item {
  return { type: 'reasoning', itemId, status, text };
}

export function contextCompaction(
  itemId: string,
  status: ItemStatus,
  fields: {
    reason?: CompactionReason;
    tokensBefore?: number;
    tokensAfter?: number;
    errorMessage?: string;
  },
): Item {
  return {
    type: 'contextCompaction',
    itemId,
    status,
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    ...(fields.tokensBefore === undefined ? {} : { tokensBefore: Math.round(fields.tokensBefore) }),
    ...(fields.tokensAfter === undefined ? {} : { tokensAfter: Math.round(fields.tokensAfter) }),
    ...(fields.errorMessage === undefined
      ? {}
      : { errorMessage: fields.errorMessage.toWellFormed() }),
  };
}

/** Output text bounded to its last `MAX_ITEM_OUTPUT` code units, as well-formed UTF-16. */
export function boundOutput(text: string): string {
  if (text.length <= MAX_ITEM_OUTPUT) {
    return text.toWellFormed();
  }
  const omitted = text.length - MAX_ITEM_OUTPUT;
  return `[${String(omitted)} characters omitted]\n${text.slice(-MAX_ITEM_OUTPUT)}`.toWellFormed();
}

/**
 * Tool arguments as items carry them: well-formed strings, and a note instead of arguments too
 * large or too deeply nested for a frame (the tool still got the original arguments).
 */
export function boundArguments(args: Record<string, unknown>): Record<string, unknown> {
  if (depthOf(args, 0) > MAX_ARGUMENT_DEPTH) {
    return { piarcOmitted: `arguments nested deeper than ${String(MAX_ARGUMENT_DEPTH)} levels` };
  }
  const size = JSON.stringify(args).length;
  if (size > MAX_ITEM_ARGUMENTS) {
    return { piarcOmitted: `arguments of ${String(size)} characters` };
  }
  return wellFormedJson(args);
}

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_ARGUMENT_DEPTH) {
    return depth;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce<number>(
      (max, item) => Math.max(max, depthOf(item, depth + 1)),
      depth,
    );
  }
  return depth;
}

/** The text parts of a tool result or message content, joined. */
export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .flatMap((part: unknown) =>
      isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

/** The text of a tool result (`{ content }`). */
export function resultText(result: unknown): string | undefined {
  return isObject(result) ? contentText(result.content) : undefined;
}

/** Pi's per-response usage, summed into a turn's usage. */
export function addUsage(total: TurnUsage, usage: unknown): TurnUsage {
  if (!isObject(usage)) {
    return total;
  }
  const count = (name: string): number => {
    const value = usage[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const cost = isObject(usage.cost) && typeof usage.cost.total === 'number' ? usage.cost.total : 0;
  return {
    inputTokens: total.inputTokens + count('input'),
    outputTokens: total.outputTokens + count('output'),
    cacheReadTokens: total.cacheReadTokens + count('cacheRead'),
    cacheWriteTokens: total.cacheWriteTokens + count('cacheWrite'),
    cost: total.cost + (Number.isFinite(cost) ? cost : 0),
  };
}

export const NO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
