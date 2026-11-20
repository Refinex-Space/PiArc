// L3 normalization (T30): a recording becomes the side-independent comparison document that
// scripts/l3/diff.mjs compares field by field.
//
// - Requests: main-loop requests only (auxiliary ones are counted). Per request the
//   top-level keys, each tool's parameters (type) and required list, the system segment count
//   and cache breakpoints, and each message as `role: block block*` (`*` = cache breakpoint).
//   Lengths and hashes of text are not compared: the two products' wording differs by design.
// - Tool calls: keyed by the scripted call id, with the canonical tool name, the input in
//   Claude Code's parameters (PiArc's mapped back, scripts/l3/scenario.mjs) and the status
//   (`completed`, `failed`, `declined`, `interrupted`, or `absent`).
// - Approvals as `<tool> <call> <decision>` in order; hooks as their order and one record per
//   invocation (`<hook>#<run>`); the final status; the workspace's file hashes.
//
// Ids, timestamps and absolute paths are already gone (the recorder replaced paths with
// <WS>, <HOME> and <TMP>; ids other than the script's never reach a recording).
import { isRecord } from '../lib/repo.mjs';
import { toCanonical } from './scenario.mjs';

/** Model-visible names that are another name for a canonical tool. */
export const TOOL_NAMES = /** @type {Record<string, string>} */ ({ Task: 'Agent' });

/** @param {string} name */
const canonicalName = (name) => TOOL_NAMES[name] ?? name;

/**
 * @param {unknown} schema
 * @returns {string} The type of a parameter's schema.
 */
function typeOf(schema) {
  if (!isRecord(schema)) return 'any';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.map(String).join('|');
  for (const key of ['anyOf', 'oneOf', 'allOf', 'enum', 'const']) {
    if (key in schema) return key;
  }
  return 'any';
}

/**
 * @param {Record<string, unknown>} tool
 * @returns {{ params: Record<string, string>, required: string[] }}
 */
function toolShape(tool) {
  const schema = isRecord(tool.input_schema) ? tool.input_schema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    params: Object.fromEntries(
      Object.keys(properties)
        .sort()
        .map((name) => [name, typeOf(properties[name])]),
    ),
    required: (Array.isArray(schema.required) ? schema.required.map(String) : []).sort(),
  };
}

/** @param {unknown} block */
function blockLabel(block) {
  if (!isRecord(block)) return '?';
  return `${String(block.type)}${block.cache === true ? '*' : ''}`;
}

/**
 * @param {Record<string, unknown>} structure
 */
function requestShape(structure) {
  const tools = Array.isArray(structure.tools) ? structure.tools.filter(isRecord) : [];
  const system = Array.isArray(structure.system) ? structure.system.filter(isRecord) : [];
  const messages = Array.isArray(structure.messages) ? structure.messages.filter(isRecord) : [];
  return {
    keys: Array.isArray(structure.keys) ? structure.keys.map(String) : [],
    tools: Object.fromEntries(
      tools
        .map(
          (t) =>
            /** @type {[string, ReturnType<typeof toolShape>]} */ ([
              canonicalName(String(t.name ?? t.type)),
              toolShape(t),
            ]),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    system: {
      segments: system.length,
      cache: system.flatMap((s, i) => (s.cache === true ? [i] : [])),
    },
    messages: messages.map((m) => {
      const content = Array.isArray(m.content) ? m.content : [];
      return `${String(m.role)}: ${content.map(blockLabel).join(' ')}`;
    }),
  };
}

/**
 * Hook records in log order, with the records of one event for one tool call (hooks that
 * run in parallel) sorted by hook name so their arrival order does not matter.
 * @param {Record<string, unknown>[]} hooks
 */
function stableHooks(hooks) {
  /** @type {Record<string, unknown>[][]} */
  const groups = [];
  for (const hook of hooks) {
    const last = groups.at(-1);
    const head = last?.[0];
    if (
      last !== undefined &&
      head !== undefined &&
      head.event === hook.event &&
      head.tool_use_id === hook.tool_use_id
    ) {
      last.push(hook);
    } else {
      groups.push([hook]);
    }
  }
  return groups.flatMap((g) => g.sort((a, b) => String(a.hook).localeCompare(String(b.hook))));
}

/**
 * The comparison document of one recording.
 * @param {import('./recording.mjs').Recording} recording
 */
export function normalize(recording) {
  const structures = recording.requests
    .filter(isRecord)
    .map((r) => (isRecord(r.structure) ? r.structure : {}));
  const main = structures.filter((s) => s.kind === 'main');
  /** @type {string[]} */
  const order = [];
  /** @type {Record<string, { tool: string, input: Record<string, unknown> }>} */
  const inputs = {};
  /** @type {Record<string, { is_error: boolean }>} */
  const results = {};
  for (const structure of main) {
    for (const message of Array.isArray(structure.messages)
      ? structure.messages.filter(isRecord)
      : []) {
      for (const block of Array.isArray(message.content) ? message.content.filter(isRecord) : []) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (!(block.id in inputs)) order.push(block.id);
          const tool = canonicalName(String(block.name));
          const input = isRecord(block.input) ? block.input : {};
          inputs[block.id] = {
            tool,
            input: recording.side === 'piarc' ? toCanonical(tool, input) : input,
          };
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          results[block.tool_use_id] = { is_error: block.is_error === true };
        }
      }
    }
  }
  const statuses = new Map(
    recording.trace.tool_calls.filter(isRecord).map((c) => [String(c.id), String(c.status)]),
  );
  const hooks = stableHooks(recording.trace.hooks.filter(isRecord));
  return {
    requests: {
      count: main.length,
      auxiliary: structures.length - main.length,
      items: main.map(requestShape),
    },
    tool_calls: {
      order,
      calls: Object.fromEntries(
        order.map((id) => [id, { ...inputs[id], status: statuses.get(id) ?? 'absent' }]),
      ),
    },
    tool_results: results,
    asks: recording.trace.asks
      .filter(isRecord)
      .map(
        (a) =>
          `${String(a.tool)} ${String(a.call)} ${String(a.decision)}${a.scripted === false ? ' (unscripted)' : ''}`,
      ),
    hooks: {
      order: hooks.map((h) => `${String(h.event)}:${String(h.hook)}`),
      calls: Object.fromEntries(
        hooks.map((h) => [
          `${String(h.hook)}#${String(h.run)}`,
          {
            event: h.event,
            tool: h.tool,
            tool_use_id: h.tool_use_id,
            fields: h.fields,
            returned: h.returned,
          },
        ]),
      ),
    },
    final: recording.trace.final,
    files: recording.trace.files,
  };
}
