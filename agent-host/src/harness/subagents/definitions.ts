// Subagent types (T31, architecture section 6.4): the built-in ones and the definition files
// Core found (`agents/list`), merged by name. Core reads the files (it owns the home directory
// and project trust); a file of the same name replaces a built-in type.
import type {
  AgentDefinition,
  AgentIssue,
  AgentSource,
  AgentWarning,
  AgentWarningKind,
  EffortLevel,
  PermissionMode,
  SubagentLimits,
} from '@piarc/protocol';

import { isObject } from '../../runtime/items.js';
import type { CoreBridge } from '../../runtime/core-bridge.js';
import { EXPLORE, GENERAL_PURPOSE, PLAN, type BuiltInText } from '../prompts/subagents.js';

/** The first entry of a subagent's session file: Core's index reads the parent from it. */
export const SUBAGENT_ENTRY = 'piarc.subagent';

/** A parent's entry recording a run's last state (`{ itemId, subagent }`): background runs,
 * failed runs; the history shows it on the `subagent` item. */
export const SUBAGENT_STATE_ENTRY = 'piarc.subagentState';

/** The type a call without `subagent_type` starts. */
export const DEFAULT_TYPE = 'general-purpose';

/** Tools of the read-only built-in types. Commands still go through the permission check. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'WebFetch',
];

function builtIn(
  name: string,
  text: BuiltInText,
  extra: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name,
    description: text.description,
    source: 'builtIn',
    prompt: text.identity,
    ...extra,
  };
}

/** The built-in types: their identities and descriptions are PiArc's own (ADR-0006). */
export const BUILT_IN_TYPES: readonly AgentDefinition[] = [
  builtIn(DEFAULT_TYPE, GENERAL_PURPOSE, { model: 'inherit' }),
  builtIn('Explore', EXPLORE, {
    tools: [...READ_ONLY_TOOLS],
    model: 'fast',
    omitProjectContext: true,
  }),
  builtIn('Plan', PLAN, {
    tools: [...READ_ONLY_TOOLS],
    model: 'inherit',
    omitProjectContext: true,
  }),
];

/** The types of one directory, with what Core decided about them. */
export interface AgentCatalog {
  /** Every type in effect, files first; `denied` ones cannot be started. */
  readonly agents: readonly AgentDefinition[];
  readonly issues: readonly AgentIssue[];
  readonly limits: SubagentLimits;
  /** Alias → `<provider>/<model id>`. */
  readonly aliases: Readonly<Record<string, string>>;
}

/** The catalog before Core answered, or when it cannot: the built-in types only. */
export const DEFAULT_LIMITS: SubagentLimits = { maxDepth: 3, maxConcurrent: 8 };

/** Merges Core's definitions with the built-in types. */
export function catalogOf(core: CoreAgents): AgentCatalog {
  const files = core.agents;
  const names = new Set(files.map((agent) => agent.name));
  const denied = new Set(core.deniedBuiltIn);
  const builtIns = BUILT_IN_TYPES.filter((agent) => !names.has(agent.name)).map((agent) =>
    denied.has(agent.name) ? { ...agent, denied: true } : agent,
  );
  return {
    agents: [...files, ...builtIns],
    issues: core.issues,
    limits: core.limits,
    aliases: core.aliases,
  };
}

/** The types a session may start. */
export function startable(catalog: AgentCatalog): readonly AgentDefinition[] {
  return catalog.agents.filter((agent) => agent.denied !== true);
}

/** Core's answer to `agents/list`, checked at the boundary. */
export interface CoreAgents {
  readonly agents: readonly AgentDefinition[];
  readonly issues: readonly AgentIssue[];
  readonly limits: SubagentLimits;
  readonly deniedBuiltIn: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
}

const SOURCES = new Set<string>([
  'projectPiarc',
  'projectClaude',
  'user',
  'userClaude',
  'plugin',
  'builtIn',
]);
const MODES = new Set<string>(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const EFFORTS = new Set<string>(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
const WARNINGS = new Set<string>([
  'ignoredField',
  'inactiveField',
  'projectModeIgnored',
  'unsupportedMode',
  'modeClamped',
  'hooksUntrusted',
  'aliasFallback',
  'effortUnsupported',
]);

const isString = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const optional = <T>(value: unknown, check: (v: unknown) => v is T): value is T | undefined =>
  value === undefined || check(value);

function parseWarning(value: unknown): AgentWarning | undefined {
  if (
    !isObject(value) ||
    !isString(value.kind) ||
    !WARNINGS.has(value.kind) ||
    !optional(value.field, isString) ||
    !optional(value.value, isString) ||
    !optional(value.task, isString)
  )
    return undefined;
  return {
    kind: value.kind as AgentWarningKind,
    ...(value.field === undefined ? {} : { field: value.field }),
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(value.task === undefined ? {} : { task: value.task }),
  };
}

function parseDefinition(value: unknown): AgentDefinition | undefined {
  if (
    !isObject(value) ||
    !isString(value.name) ||
    !isString(value.description) ||
    !isString(value.prompt) ||
    !isString(value.source) ||
    !SOURCES.has(value.source) ||
    !optional(value.path, isString) ||
    !optional(value.tools, strings) ||
    !optional(value.disallowedTools, strings) ||
    !optional(value.model, isString) ||
    !(
      value.permissionMode === undefined ||
      (isString(value.permissionMode) && MODES.has(value.permissionMode))
    ) ||
    !(value.maxTurns === undefined || (typeof value.maxTurns === 'number' && value.maxTurns > 0)) ||
    !optional(value.skills, strings) ||
    !optional(value.mcpServers, strings) ||
    !(value.effort === undefined || (isString(value.effort) && EFFORTS.has(value.effort))) ||
    !optional(value.color, isString) ||
    !optional(value.isolation, isString) ||
    !optional(value.overrides, strings) ||
    !(value.warnings === undefined || Array.isArray(value.warnings))
  )
    return undefined;
  const warnings = (value.warnings ?? []).map(parseWarning);
  if (warnings.some((w) => w === undefined)) return undefined;
  return {
    name: value.name,
    description: value.description,
    source: value.source as AgentSource,
    prompt: value.prompt,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.tools === undefined ? {} : { tools: value.tools }),
    ...(value.disallowedTools === undefined ? {} : { disallowedTools: value.disallowedTools }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.permissionMode === undefined
      ? {}
      : { permissionMode: value.permissionMode as PermissionMode }),
    ...(value.maxTurns === undefined ? {} : { maxTurns: value.maxTurns }),
    ...(value.skills === undefined ? {} : { skills: value.skills }),
    ...(value.mcpServers === undefined ? {} : { mcpServers: value.mcpServers }),
    ...(value.hooks === true ? { hooks: true } : {}),
    ...(value.isolation === undefined ? {} : { isolation: value.isolation }),
    ...(value.background === true ? { background: true } : {}),
    ...(value.effort === undefined ? {} : { effort: value.effort as EffortLevel }),
    ...(value.color === undefined ? {} : { color: value.color }),
    ...(value.overrides === undefined ? {} : { overrides: value.overrides }),
    ...(warnings.length === 0 ? {} : { warnings: warnings as AgentWarning[] }),
    ...(value.denied === true ? { denied: true } : {}),
  };
}

function parseIssue(value: unknown): AgentIssue | undefined {
  if (
    !isObject(value) ||
    !isString(value.path) ||
    !isString(value.message) ||
    !(value.line === undefined || typeof value.line === 'number')
  )
    return undefined;
  return {
    path: value.path,
    message: value.message,
    ...(value.line === undefined ? {} : { line: value.line }),
  };
}

/** `agents/list`'s result, or undefined when it is not one. */
export function parseCoreAgents(value: unknown): CoreAgents | undefined {
  if (!isObject(value) || !Array.isArray(value.agents) || !isObject(value.limits)) return undefined;
  const { maxDepth, maxConcurrent } = value.limits;
  if (
    typeof maxDepth !== 'number' ||
    typeof maxConcurrent !== 'number' ||
    maxDepth < 1 ||
    maxConcurrent < 1
  )
    return undefined;
  const agents = value.agents.map(parseDefinition);
  const issues = (Array.isArray(value.issues) ? value.issues : []).map(parseIssue);
  const denied = value.deniedBuiltIn ?? [];
  const aliases = value.aliases ?? {};
  if (
    agents.some((a) => a === undefined) ||
    issues.some((i) => i === undefined) ||
    !strings(denied) ||
    !isObject(aliases) ||
    !Object.values(aliases).every(isString)
  )
    return undefined;
  return {
    agents: agents as AgentDefinition[],
    issues: issues as AgentIssue[],
    limits: { maxDepth, maxConcurrent },
    deniedBuiltIn: denied,
    aliases: aliases as Record<string, string>,
  };
}

/** Asks Core for the definitions found from `cwd`. */
export async function fetchCatalog(bridge: CoreBridge, cwd: string): Promise<AgentCatalog> {
  const core = await bridge.requestTyped(
    'agents/list',
    { cwd, builtIn: BUILT_IN_TYPES.map((agent) => agent.name) },
    parseCoreAgents,
  );
  return catalogOf(core);
}
