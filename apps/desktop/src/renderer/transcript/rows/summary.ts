// What a tool group's summary says (architecture section 8.2: verb + object + lines added and
// removed): the calls counted by what they do, the single call's object named, and the file
// changes' line counts summed. Pure functions over Core's items; the row turns them into text.
import type { Item, ItemStatus } from '@piarc/protocol';

export type ToolVerb = 'read' | 'search' | 'find' | 'edit' | 'fetch' | 'mcp' | 'agent' | 'other';

export interface ToolPart {
  readonly verb: ToolVerb;
  readonly count: number;
  /** The object, when the verb has exactly one call. */
  readonly target: string | undefined;
}

export interface GroupSummary {
  readonly parts: readonly ToolPart[];
  readonly added: number;
  readonly removed: number;
  /** In progress while any call is; otherwise the worst final state. */
  readonly status: ItemStatus;
}

const VERB_ORDER: readonly ToolVerb[] = [
  'read',
  'search',
  'find',
  'edit',
  'fetch',
  'mcp',
  'agent',
  'other',
];

function toolOf(item: Item): string {
  return 'tool' in item ? item.tool : item.type;
}

function argument(item: Item, name: string): string | undefined {
  if (!('arguments' in item)) {
    return undefined;
  }
  const value = item.arguments[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** What a tool call does. */
export function verbOf(item: Item): ToolVerb {
  switch (item.type) {
    case 'fileChange':
      return 'edit';
    case 'webFetch':
      return 'fetch';
    case 'mcpToolCall':
      return 'mcp';
    case 'subagent':
      return 'agent';
    default:
      break;
  }
  switch (toolOf(item)) {
    case 'Read':
      return 'read';
    case 'Grep':
      return 'search';
    case 'Glob':
      return 'find';
    default:
      return 'other';
  }
}

/** The last component of a path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

/** What a call acts on, as one short label. */
export function targetOf(item: Item): string {
  switch (item.type) {
    case 'fileChange':
      return baseName(item.path);
    case 'webFetch':
      try {
        return new URL(item.url).host || item.url;
      } catch {
        return item.url;
      }
    case 'mcpToolCall':
      return `${item.server} · ${item.serverTool}`;
    case 'subagent':
      return item.description ?? item.tool;
    case 'commandExecution':
      return item.command;
    default:
      break;
  }
  switch (verbOf(item)) {
    case 'read': {
      const path = argument(item, 'path') ?? argument(item, 'file_path');
      return path === undefined ? toolOf(item) : baseName(path);
    }
    case 'search':
    case 'find':
      return argument(item, 'pattern') ?? toolOf(item);
    default:
      return toolOf(item);
  }
}

const STATUS_RANK: Record<ItemStatus, number> = {
  completed: 0,
  declined: 1,
  interrupted: 2,
  failed: 3,
  inProgress: 4,
};

/** The summary of a group's calls. */
export function summarize(items: readonly Item[]): GroupSummary {
  const byVerb = new Map<ToolVerb, Item[]>();
  let added = 0;
  let removed = 0;
  let status: ItemStatus = 'completed';
  for (const item of items) {
    const verb = verbOf(item);
    byVerb.set(verb, [...(byVerb.get(verb) ?? []), item]);
    if (item.type === 'fileChange' && item.diff !== undefined && item.diff !== null) {
      added += item.diff.added;
      removed += item.diff.removed;
    }
    if (STATUS_RANK[item.status] > STATUS_RANK[status]) {
      status = item.status;
    }
  }
  const parts = VERB_ORDER.flatMap((verb) => {
    const calls = byVerb.get(verb);
    if (calls === undefined) {
      return [];
    }
    const only = calls.length === 1 ? calls[0] : undefined;
    return [{ verb, count: calls.length, target: only === undefined ? undefined : targetOf(only) }];
  });
  return { parts, added, removed, status };
}
