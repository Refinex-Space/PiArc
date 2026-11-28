// L3 scenarios (tests/l3/scenarios/*.yaml, schema tests/l3/schema.json): loading, and what
// each side runs (docs/engineering/testing.md section 14).
//
// - PiArc: `piarcScenario` turns a scenario into an L2 scenario for `piarc-devcli l3` (tool
//   inputs mapped to PiArc's parameters, the mirrored L2 scenarios' capabilities).
// - Claude Code: `mockScript` is the mock's script with `{{workspace}}` filled in, and
//   `workspaceFiles` the files both sides start from.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import { isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

export const SCENARIO_DIR = path.join(repoRoot, 'tests', 'l3', 'scenarios');
export const L2_DIR = path.join(repoRoot, 'tests', 'scenarios');
export const WORKSPACE_PLACEHOLDER = '{{workspace}}';
/** The fixtures' directory inside the workspace; the comparison leaves it out. */
export const L3_DIR = '.l3';
export const HOOK_FIXTURE = path.join(repoRoot, 'scripts', 'l3', 'fixtures', 'hook.mjs');

/**
 * @typedef {{ call: string, decision: 'allow' | 'deny', feedback?: string }} Approval
 * @typedef {{ id: string, area: 'permissions' | 'hooks', description: string,
 *   mirrors: string[], mode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
 *   trusted: boolean,
 *   workspace: { files: Record<string, string>, user_settings?: Record<string, unknown>,
 *     plans: Record<string, Record<string, unknown>> },
 *   prompt: string, steps: Record<string, unknown>[], approvals: Approval[] }} Scenario
 */

/**
 * Converts one tool input between Claude Code's parameters (the scenarios' and the
 * comparison's canonical form) and PiArc's, which keeps Pi's parameters (ADR-0020).
 * Parameters a mapping does not list are dropped.
 * @type {Record<string, { toPiarc: (input: Record<string, unknown>) => Record<string, unknown>,
 *   toCanonical: (input: Record<string, unknown>) => Record<string, unknown> }>}
 */
export const PARAMETERS = {
  Read: {
    toPiarc: (i) => pick({ path: i.file_path, offset: i.offset, limit: i.limit, pages: i.pages }),
    toCanonical: (i) =>
      pick({ file_path: i.path, offset: i.offset, limit: i.limit, pages: i.pages }),
  },
  Write: {
    toPiarc: (i) => pick({ path: i.file_path, content: i.content }),
    toCanonical: (i) => pick({ file_path: i.path, content: i.content }),
  },
  Edit: {
    toPiarc: (i) =>
      pick({
        path: i.file_path,
        edits: [{ oldText: i.old_string, newText: i.new_string }],
        replaceAll: i.replace_all,
      }),
    toCanonical: (i) => {
      const edit = Array.isArray(i.edits) && isRecord(i.edits[0]) ? i.edits[0] : {};
      return pick({
        file_path: i.path,
        old_string: edit.oldText,
        new_string: edit.newText,
        replace_all: i.replaceAll,
      });
    },
  },
  Bash: {
    toPiarc: (i) =>
      pick({
        command: i.command,
        timeout: typeof i.timeout === 'number' ? i.timeout / 1000 : undefined,
      }),
    toCanonical: (i) =>
      pick({
        command: i.command,
        timeout: typeof i.timeout === 'number' ? i.timeout * 1000 : undefined,
      }),
  },
};

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>} `object` without its undefined members.
 */
function pick(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 */
export function toPiarc(tool, input) {
  const mapping = PARAMETERS[tool];
  return mapping === undefined ? input : mapping.toPiarc(input);
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 */
export function toCanonical(tool, input) {
  const mapping = PARAMETERS[tool];
  return mapping === undefined ? input : mapping.toCanonical(input);
}

const schema = readJsonFile(path.join(repoRoot, 'tests', 'l3', 'schema.json'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateFile = ajv.compile(isRecord(schema) ? schema : {});

/**
 * Parses and checks one scenario file.
 * @param {string} file
 * @returns {{ scenario?: Scenario, problems: string[] }}
 */
export function loadScenario(file) {
  const name = path.basename(file, '.yaml');
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { problems: [`${name}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!validateFile(doc) || !isRecord(doc)) {
    const errors = validateFile.errors ?? [];
    return {
      problems: errors.map((e) => `${name}: ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`),
    };
  }
  /** @type {string[]} */
  const problems = [];
  if (doc.id !== name)
    problems.push(`${name}: id \`${String(doc.id)}\` differs from the file name`);
  const mirrors = /** @type {string[]} */ (doc.mirrors);
  for (const l2 of mirrors) {
    if (!readdirSync(L2_DIR).includes(`${l2}.yaml`)) {
      problems.push(`${name}: mirrors ${l2}, which is not in tests/scenarios/`);
    }
  }
  const workspace = isRecord(doc.workspace) ? doc.workspace : {};
  /** @type {Scenario} */
  const scenario = {
    id: name,
    area: doc.area === 'hooks' ? 'hooks' : 'permissions',
    description: String(doc.description),
    mirrors,
    trusted: doc.trusted !== false,
    workspace: {
      files: /** @type {Record<string, string>} */ (workspace.files ?? {}),
      plans: /** @type {Record<string, Record<string, unknown>>} */ (workspace.plans ?? {}),
      ...(isRecord(workspace.user_settings) ? { user_settings: workspace.user_settings } : {}),
    },
    prompt: String(doc.prompt),
    steps: /** @type {Record<string, unknown>[]} */ (doc.steps),
    approvals: /** @type {Approval[]} */ (doc.approvals ?? []),
  };
  if (
    doc.mode === 'default' ||
    doc.mode === 'acceptEdits' ||
    doc.mode === 'plan' ||
    doc.mode === 'bypassPermissions'
  ) {
    scenario.mode = doc.mode;
  }
  for (const [n, call] of toolCalls(scenario.steps).entries()) {
    if (PARAMETERS[call.name] === undefined) {
      problems.push(
        `${name}: tool call ${String(n)} uses ${call.name}, which has no parameter mapping`,
      );
    }
  }
  return problems.length > 0 ? { problems } : { scenario, problems };
}

/**
 * Every scenario file of `dir`, sorted by id.
 * @param {string} [dir]
 * @returns {{ scenarios: Scenario[], problems: string[] }}
 */
export function loadScenarios(dir = SCENARIO_DIR) {
  /** @type {Scenario[]} */
  const scenarios = [];
  /** @type {string[]} */
  const problems = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const loaded = loadScenario(path.join(dir, file));
    problems.push(...loaded.problems);
    if (loaded.scenario !== undefined) scenarios.push(loaded.scenario);
  }
  return { scenarios, problems };
}

/**
 * @param {Record<string, unknown>[]} steps
 * @returns {{ name: string, input: Record<string, unknown>, call: Record<string, unknown> }[]}
 */
function toolCalls(steps) {
  return steps.flatMap((step) =>
    (Array.isArray(step.tool_calls) ? step.tool_calls : []).filter(isRecord).map((call) => ({
      name: String(call.name),
      input: isRecord(call.input) ? call.input : {},
      call,
    })),
  );
}

/**
 * @param {Record<string, unknown>[]} steps
 * @param {(name: string, input: Record<string, unknown>) => Record<string, unknown>} mapInput
 * @returns {Record<string, unknown>[]} `steps` with every tool input replaced.
 */
function mapSteps(steps, mapInput) {
  return steps.map((step) =>
    Array.isArray(step.tool_calls)
      ? {
          ...step,
          tool_calls: step.tool_calls.filter(isRecord).map((call) => ({
            ...call,
            input: mapInput(String(call.name), isRecord(call.input) ? call.input : {}),
          })),
        }
      : step,
  );
}

/**
 * Replaces `{{workspace}}` in every string of `value`.
 * @param {unknown} value
 * @param {string} workspace
 * @returns {unknown}
 */
export function fillWorkspace(value, workspace) {
  if (typeof value === 'string') return value.replaceAll(WORKSPACE_PLACEHOLDER, workspace);
  if (Array.isArray(value)) return value.map((v) => fillWorkspace(v, workspace));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillWorkspace(v, workspace)]),
    );
  }
  return value;
}

/**
 * The files both sides start from: the scenario's, the hook fixture and its plans.
 * @param {Scenario} scenario
 * @returns {Record<string, string>}
 */
export function workspaceFiles(scenario) {
  /** @type {Record<string, string>} */
  const files = { ...scenario.workspace.files };
  files[`${L3_DIR}/hook.mjs`] = readFileSync(HOOK_FIXTURE, 'utf8');
  for (const [name, plan] of Object.entries(scenario.workspace.plans)) {
    files[`${L3_DIR}/plans/${name}.json`] = `${JSON.stringify(plan)}\n`;
  }
  return files;
}

/**
 * The mock script of the Claude Code side.
 * @param {Scenario} scenario
 * @param {string} workspace absolute path
 */
export function mockScript(scenario, workspace) {
  return { id: scenario.id, steps: fillWorkspace(scenario.steps, workspace) };
}

/**
 * The capabilities of the mirrored L2 scenarios.
 * @param {Scenario} scenario
 * @returns {string[]}
 */
function mirroredCapabilities(scenario) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const l2 of scenario.mirrors) {
    /** @type {unknown} */
    const doc = parse(readFileSync(path.join(L2_DIR, `${l2}.yaml`), 'utf8'));
    if (isRecord(doc) && Array.isArray(doc.capabilities)) {
      for (const id of doc.capabilities) if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * The L2 scenario `piarc-devcli l3` runs for the PiArc side. Its tool inputs keep the
 * `{{workspace}}` placeholder; the L2 runner fills it in.
 * @param {Scenario} scenario
 * @returns {Record<string, unknown>}
 */
export function piarcScenario(scenario) {
  const settings = scenario.workspace.user_settings;
  /** @type {Record<string, string>} */
  const runFiles = {};
  if (settings !== undefined) runFiles['home 家/.claude/settings.json'] = JSON.stringify(settings);
  if (scenario.mode === 'bypassPermissions') {
    // PiArc offers the mode only after the user enables it (T23).
    runFiles['data 数据/settings.json'] = JSON.stringify({
      permissions: { enableBypassPermissions: true },
    });
  }
  return {
    id: scenario.id,
    description: `L3 PiArc side of ${scenario.id}: ${scenario.description}`,
    capabilities: mirroredCapabilities(scenario),
    workspace: {
      trusted: scenario.trusted,
      files: workspaceFiles(scenario),
      ...(Object.keys(runFiles).length === 0 ? {} : { run_files: runFiles }),
    },
    providers: { main: { wire: 'anthropic', steps: mapSteps(scenario.steps, toPiarc) } },
    ...(scenario.mode === undefined
      ? {}
      : { sessions: { main: { provider: 'main', mode: scenario.mode } } }),
    // `claude -p` ends its session after the turn; archiving ends PiArc's the same way
    // (SessionEnd hooks run on both sides).
    actions: [
      { prompt: { text: scenario.prompt, turn: 't' } },
      { wait: { method: 'turn/completed', turn: 't' } },
      { set_prefs: { archived: true } },
    ],
    approvals: scenario.approvals.map((a) => ({
      call: a.call,
      decision: a.decision,
      ...(a.feedback === undefined ? {} : { feedback: a.feedback }),
    })),
    // The comparison is the assertion; the runner still checks every request against the
    // mock's protocol rules.
    expect: { files: {} },
  };
}
