// The L3 report (T30): tmp/l3/report.md for people and tmp/l3/results.json for tools. The
// first line names both sides' versions.
import { isRecord } from '../lib/repo.mjs';

/**
 * @typedef {{ id: string, area: string, mirrors: string[],
 *   allowed: { difference: import('./diff.mjs').Difference, entry: import('./allowlist.mjs').Entry }[],
 *   unexplained: import('./diff.mjs').Difference[],
 *   piarc: ReturnType<typeof import('./normalize.mjs').normalize>,
 *   claude: ReturnType<typeof import('./normalize.mjs').normalize>,
 *   runProblems: string[], repeatDifferences: string[] }} ScenarioResult
 * @typedef {{ piarcVersion: string, claudeVersion: string, scenarios: ScenarioResult[],
 *   excluded: import('./allowlist.mjs').Exclusion[], stale: import('./allowlist.mjs').Entry[],
 *   problems: string[], recordingCheck: { files: number, problems: string[] },
 *   home: { files: number, changes: string[] }, repeat: number }} Results
 */

/** @param {unknown} value */
function cell(value) {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `\`${text.replaceAll('|', '\\|').replaceAll('`', "'")}\``;
}

/**
 * The hooks part of a scenario: order and one row per invocation on either side.
 * @param {ScenarioResult} s
 * @returns {string[]}
 */
function hooksSection(s) {
  const lines = ['', '#### Hooks', ''];
  lines.push(`- Order, PiArc: ${s.piarc.hooks.order.join(' → ') || '—'}`);
  lines.push(`- Order, Claude Code: ${s.claude.hooks.order.join(' → ') || '—'}`);
  lines.push(
    '',
    '| Invocation | Event | Input fields: PiArc | Input fields: Claude Code | Decision: PiArc | Decision: Claude Code |',
    '|---|---|---|---|---|---|',
  );
  const keys = [
    ...new Set([...Object.keys(s.piarc.hooks.calls), ...Object.keys(s.claude.hooks.calls)]),
  ].sort();
  for (const key of keys) {
    const p = s.piarc.hooks.calls[key];
    const c = s.claude.hooks.calls[key];
    /** @param {unknown} call @param {string} field */
    const get = (call, field) => (isRecord(call) ? call[field] : undefined);
    const returned = (/** @type {unknown} */ call) => {
      const r = get(call, 'returned');
      return isRecord(r) ? `exit ${String(r.exit)}, ${String(r.decision)}` : undefined;
    };
    const fields = (/** @type {unknown} */ call) => {
      const f = get(call, 'fields');
      return Array.isArray(f) ? f.join(', ') : undefined;
    };
    lines.push(
      `| ${key} | ${String(get(p, 'event') ?? get(c, 'event'))} | ${cell(fields(p))} | ${cell(fields(c))} | ${cell(returned(p))} | ${cell(returned(c))} |`,
    );
  }
  return lines;
}

/**
 * @param {Results} results
 * @returns {string}
 */
export function renderReport(results) {
  const unexplained = results.scenarios.reduce((n, s) => n + s.unexplained.length, 0);
  const allowed = results.scenarios.reduce((n, s) => n + s.allowed.length, 0);
  const lines = [
    `# L3 report: PiArc ${results.piarcVersion} vs Claude Code ${results.claudeVersion}`,
    '',
    `${String(results.scenarios.length)} scenario(s), ${String(unexplained)} unexplained difference(s), ${String(allowed)} allowed by tests/l3-allowlist.yaml, ${String(results.stale.length)} stale allowlist entr${results.stale.length === 1 ? 'y' : 'ies'}; each side ran ${String(results.repeat)} time(s).`,
    '',
    '## Checks',
    '',
    `- Recording check (scripts/l3/check-recordings.mjs): ${results.recordingCheck.problems.length === 0 ? 'passed' : 'FAILED'}, ${String(results.recordingCheck.files)} file(s).`,
    `- ~/.claude before and after: ${String(results.home.files)} entries, ${results.home.changes.length === 0 ? 'unchanged' : `CHANGED (${String(results.home.changes.length)})`}.`,
    ...results.home.changes.map((c) => `  - ${c}`),
    ...results.recordingCheck.problems.map((p) => `  - ${p}`),
    ...results.problems.map((p) => `- Problem: ${p}`),
    ...results.stale.map(
      (e) =>
        `- Stale allowlist entry differences[${String(e.index)}] (${e.scenario}, \`${e.path}\`): it applies to this run but matches no difference.`,
    ),
    '',
    '## Scenarios',
  ];
  for (const s of results.scenarios) {
    const status =
      s.unexplained.length === 0 && s.runProblems.length === 0 && s.repeatDifferences.length === 0
        ? 'aligned'
        : 'DIFFERS';
    lines.push(
      '',
      `### ${s.id} (${s.area}): ${status}`,
      '',
      `Mirrors ${s.mirrors.join(', ')}. Final status: PiArc ${s.piarc.final.status}, Claude Code ${s.claude.final.status}.`,
    );
    for (const p of s.runProblems) lines.push(`- Run problem: ${p}`);
    for (const p of s.repeatDifferences) lines.push(`- Not repeatable: ${p}`);
    lines.push('', '| Tool call | Tool | PiArc | Claude Code |', '|---|---|---|---|');
    const ids = [...new Set([...s.piarc.tool_calls.order, ...s.claude.tool_calls.order])];
    for (const id of ids) {
      const p = s.piarc.tool_calls.calls[id];
      const c = s.claude.tool_calls.calls[id];
      lines.push(
        `| ${id} | ${String(p?.tool ?? c?.tool)} | ${p?.status ?? '—'} | ${c?.status ?? '—'} |`,
      );
    }
    lines.push(
      '',
      `Approvals: PiArc ${s.piarc.asks.join(', ') || 'none'}; Claude Code ${s.claude.asks.join(', ') || 'none'}.`,
    );
    if (s.area === 'hooks') lines.push(...hooksSection(s));
    if (s.unexplained.length > 0) {
      lines.push(
        '',
        '#### Unexplained differences',
        '',
        '| Path | PiArc | Claude Code |',
        '|---|---|---|',
      );
      for (const d of s.unexplained)
        lines.push(`| \`${d.path}\` | ${cell(d.piarc)} | ${cell(d.claude)} |`);
    }
    if (s.allowed.length > 0) {
      lines.push('', '#### Allowed differences', '', '| Path | Allowlist entry |', '|---|---|');
      for (const { difference, entry } of s.allowed) {
        lines.push(
          `| \`${difference.path}\` | differences[${String(entry.index)}] \`${entry.path}\` |`,
        );
      }
    }
  }
  if (results.excluded.length > 0) {
    lines.push('', '## Excluded', '', '| Scenario | Reason |', '|---|---|');
    for (const e of results.excluded)
      lines.push(`| ${e.scenario} | ${e.reason.replaceAll('|', '\\|')} |`);
  }
  return `${lines.join('\n')}\n`;
}
