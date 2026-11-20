// L3 hook fixture (T30). Both sides run it from the workspace as `node .l3/hook.mjs <name>`
// (it is copied to .l3/hook.mjs). It records structure only, never values:
//
// - appends {hook, event, fields, tool, tool_use_id, run, returned} as one line to
//   .l3/hooks.jsonl: the hook's name, `hook_event_name`, the sorted top-level field names of
//   its input, the tool name and call id when present, how many times this hook ran before,
//   and the decision the plan returned;
// - answers as .l3/plans/<name>.json says: one plan, or {"sequence": [plan, ...]} where run n
//   uses plan n (the last one after that). A plan: {"exit": 0, "json": {...},
//   "stdout": "text", "stderr": "text"}; no plan file means exit 0 with no output.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} json @returns {string | null} The decision a plan's JSON output carries. */
function decisionOf(json) {
  if (!isRecord(json)) return null;
  const specific = json.hookSpecificOutput;
  if (isRecord(specific)) {
    if (typeof specific.permissionDecision === 'string') return specific.permissionDecision;
    const decision = specific.decision;
    if (isRecord(decision) && typeof decision.behavior === 'string') return decision.behavior;
  }
  if (typeof json.decision === 'string') return json.decision;
  if (json.continue === false) return 'stop';
  if (isRecord(specific) && typeof specific.additionalContext === 'string') return 'context';
  return null;
}

const name = process.argv[2] ?? 'hook';
/** @type {unknown} */
const input = JSON.parse(readFileSync(process.stdin.fd, 'utf8'));
const fields = isRecord(input) ? Object.keys(input).sort() : [];
const log = path.join('.l3', 'hooks.jsonl');
const runs = existsSync(log)
  ? readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes(`"hook":${JSON.stringify(name)},`)).length
  : 0;
const planFile = path.join('.l3', 'plans', `${name}.json`);
/** @type {unknown} */
let plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
if (isRecord(plan) && Array.isArray(plan.sequence)) {
  /** @type {unknown[]} */
  const sequence = plan.sequence;
  plan = sequence[Math.min(runs, sequence.length - 1)];
}
const step = isRecord(plan) ? plan : {};
const exit = typeof step.exit === 'number' ? step.exit : 0;
const text = (/** @type {string} */ key) =>
  isRecord(input) && typeof input[key] === 'string' ? input[key] : null;
appendFileSync(
  log,
  `${JSON.stringify({
    hook: name,
    event: text('hook_event_name'),
    fields,
    tool: text('tool_name'),
    tool_use_id: text('tool_use_id'),
    run: runs,
    returned: {
      exit,
      decision:
        exit !== 0 ? null : typeof step.stdout === 'string' ? 'stdout' : decisionOf(step.json),
    },
  })}\n`,
);
if (step.json !== undefined) process.stdout.write(JSON.stringify(step.json));
if (typeof step.stdout === 'string') process.stdout.write(step.stdout);
if (typeof step.stderr === 'string') process.stderr.write(step.stderr);
process.exitCode = exit;
