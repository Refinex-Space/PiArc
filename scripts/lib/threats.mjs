// The threat map (tests/security/threats.yaml) and its checks (T45, NFR-03): every row of
// architecture section 10.1 has a THR entry, every countermeasure of the row is mapped, every
// automated countermeasure names tests that exist, deferred items wait for an unfinished task,
// tests named after a threat are mapped to it, and docs/security/threat-coverage.md is what the
// map and the L2 results generate.
import { parse } from 'yaml';

import { isRecord } from './repo.mjs';

export const TYPES = ['automated', 'process', 'accepted-risk', 'deferred'];
export const KINDS = ['cap', 'rust', 'vitest', 'l4', 'ci', 'process'];
const THREAT_ID = /^THR-[0-9]{2}$/;
const TASK = /^[TRW][0-9]{1,2}$/;

/**
 * @typedef {{ kind: string, path: string, name: string }} TestRef
 * @typedef {{ arch?: string, measure: string, type: string, tests: string[], reason?: string,
 *   task?: string, refs: string[] }} Countermeasure
 * @typedef {{ id: string, title: string, countermeasures: Countermeasure[] }} Threat
 * @typedef {{ name: string, measures: string[] }} ThreatRow
 * @typedef {{ id: string, capabilities: string[], platforms: string[], description: string }}
 *   ScenarioInfo
 * @typedef {{ files: Map<string, string>, capabilities: Map<string, string>,
 *   scenarios: ScenarioInfo[], tasks: Map<string, string> }} Inventory
 * @typedef {{ id: string, status: string, platforms: string[] }} ScenarioResult
 */

/**
 * The rows of architecture section 10.1: the threat (first column) and its countermeasures (the
 * third column split at `；`).
 * @param {string} architecture
 * @returns {ThreatRow[]}
 */
export function threatRows(architecture) {
  const lines = architecture.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### 10.1 '));
  if (start < 0) return [];
  /** @type {ThreatRow[]} */
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 3 || cells[0] === '威胁' || /^-+$/.test(cells[0] ?? '')) continue;
    const [name = '', , countermeasures = ''] = cells;
    rows.push({
      name,
      measures: countermeasures
        .split('；')
        .map((m) => m.trim())
        .filter((m) => m !== ''),
    });
  }
  return rows;
}

/**
 * A test ID: `<kind>:<path>` with `::<name>` (rust, vitest, l4) or `#<name>` (ci, process);
 * `cap:<capability id>` names the L2 scenarios that cover a capability.
 * @param {string} id
 * @returns {TestRef | undefined}
 */
export function parseTestId(id) {
  const colon = id.indexOf(':');
  if (colon < 0) return undefined;
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (!KINDS.includes(kind) || rest === '') return undefined;
  if (kind === 'cap') return { kind, path: 'tests/capabilities.yaml', name: rest };
  if (kind === 'rust' || kind === 'vitest' || kind === 'l4') {
    const at = rest.indexOf('::');
    if (at <= 0 || at + 2 >= rest.length) return undefined;
    return { kind, path: rest.slice(0, at), name: rest.slice(at + 2) };
  }
  const hash = rest.indexOf('#');
  return hash < 0
    ? { kind, path: rest, name: '' }
    : { kind, path: rest.slice(0, hash), name: rest.slice(hash + 1) };
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 */
function text(object, key) {
  const value = object[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function strings(value) {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? /** @type {string[]} */ (value)
    : undefined;
}

/**
 * Parses tests/security/threats.yaml; shape problems are returned, not thrown.
 * @param {string} source
 * @returns {{ threats: Threat[], problems: string[] }}
 */
export function parseThreats(source) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Threat[]} */
  const threats = [];
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(source);
  } catch (error) {
    return {
      threats,
      problems: [`threats.yaml: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(doc) || doc.version !== 1 || !Array.isArray(doc.threats)) {
    return { threats, problems: ['threats.yaml: needs `version: 1` and a `threats` list'] };
  }
  const allowed = new Set(['arch', 'measure', 'type', 'tests', 'reason', 'task', 'refs']);
  for (const [n, entry] of doc.threats.entries()) {
    const where = `threats[${String(n)}]`;
    if (!isRecord(entry)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    const id = text(entry, 'id');
    const title = text(entry, 'title');
    if (id === undefined || !THREAT_ID.test(id)) problems.push(`${where}: id must be THR-<NN>`);
    if (title === undefined) problems.push(`${where}: needs a title`);
    if (!Array.isArray(entry.countermeasures) || entry.countermeasures.length === 0) {
      problems.push(`${where}: needs countermeasures`);
      continue;
    }
    /** @type {Countermeasure[]} */
    const countermeasures = [];
    for (const [m, item] of entry.countermeasures.entries()) {
      const at = `${id ?? where}.countermeasures[${String(m)}]`;
      if (!isRecord(item)) {
        problems.push(`${at}: must be a mapping`);
        continue;
      }
      for (const key of Object.keys(item).filter((k) => !allowed.has(k))) {
        problems.push(`${at}: unknown field \`${key}\``);
      }
      const measure = text(item, 'measure');
      const type = text(item, 'type');
      const tests = strings(item.tests);
      const refs = strings(item.refs);
      const arch = text(item, 'arch');
      const reason = text(item, 'reason');
      const task = text(item, 'task');
      if (measure === undefined) problems.push(`${at}: needs a measure`);
      if (type === undefined || !TYPES.includes(type)) {
        problems.push(`${at}: type must be one of ${TYPES.join(', ')}`);
      }
      if (tests === undefined) problems.push(`${at}: tests must be a list of test IDs`);
      if (refs === undefined) problems.push(`${at}: refs must be a list`);
      if (type === 'automated' && tests?.length === 0) {
        problems.push(`${at}: an automated countermeasure needs at least one test`);
      }
      if (type !== 'automated' && reason === undefined) {
        problems.push(`${at}: a ${type ?? '?'} countermeasure needs a reason`);
      }
      if (type === 'deferred' && (task === undefined || !TASK.test(task))) {
        problems.push(`${at}: a deferred countermeasure names the task that will test it`);
      }
      if (
        measure === undefined ||
        type === undefined ||
        tests === undefined ||
        refs === undefined
      ) {
        continue;
      }
      countermeasures.push({
        measure,
        type,
        tests,
        refs,
        ...(arch === undefined ? {} : { arch }),
        ...(reason === undefined ? {} : { reason }),
        ...(task === undefined ? {} : { task }),
      });
    }
    if (id !== undefined && title !== undefined) threats.push({ id, title, countermeasures });
  }
  const ids = threats.map((t) => t.id);
  for (const id of new Set(ids.filter((value, i) => ids.indexOf(value) !== i))) {
    problems.push(`${id}: listed twice`);
  }
  return { threats, problems };
}

/**
 * @param {string} value
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `source` declares a test function `name`: `fn name(` after a test attribute.
 * @param {string} source
 * @param {string} name
 */
export function hasRustTest(source, name) {
  const match = new RegExp(`\\bfn\\s+${escapeRegExp(name)}\\s*[<(]`).exec(source);
  if (match === null) return false;
  const attributes = source.slice(0, match.index).split('\n').slice(-8).join('\n');
  return /#\[(tokio::)?test\b/.test(attributes);
}

/**
 * Whether `source` has a Vitest or Playwright test titled `title` (not skipped or todo).
 * @param {string} source
 * @param {string} title
 */
export function hasTitledTest(source, title) {
  const quoted = ["'", '"', '`'].map((q) => `${q}${escapeRegExp(title)}${q}`).join('|');
  const call = new RegExp(
    `\\b(it|test)((\\.(each|runIf|skipIf|concurrent|sequential|serial)(\\([^)]*\\))?)*)\\(\\s*(${quoted})`,
  );
  const match = call.exec(source);
  return match !== null && !/\.(skip|todo|fixme)\b/.test(match[2] ?? '');
}

/**
 * Resolves one test ID against the inventory; returns the problem or undefined.
 * @param {string} id
 * @param {Inventory} inventory
 * @returns {string | undefined}
 */
export function resolveTest(id, inventory) {
  const ref = parseTestId(id);
  if (ref === undefined) {
    return `\`${id}\` is not a test ID (<kind>:<path>::<name>, cap:<CAP-ID>, ci:<path>#<check>, process:<path>#<marker>)`;
  }
  if (ref.kind === 'cap') {
    const status = inventory.capabilities.get(ref.name);
    if (status === undefined) return `\`${id}\`: no such capability in tests/capabilities.yaml`;
    if (status !== 'active') return `\`${id}\`: the capability is ${status}, not active`;
    if (!inventory.scenarios.some((s) => s.capabilities.includes(ref.name))) {
      return `\`${id}\`: no L2 scenario covers the capability`;
    }
    return undefined;
  }
  const source = inventory.files.get(ref.path);
  if (source === undefined) return `\`${id}\`: ${ref.path} does not exist`;
  if (ref.kind === 'rust') {
    return hasRustTest(source, ref.name) ? undefined : `\`${id}\`: no test fn ${ref.name}`;
  }
  if (ref.kind === 'vitest' || ref.kind === 'l4') {
    return hasTitledTest(source, ref.name) ? undefined : `\`${id}\`: no test titled "${ref.name}"`;
  }
  if (ref.kind === 'process') {
    return ref.name === '' || source.includes(`<!-- ${ref.name} -->`)
      ? undefined
      : `\`${id}\`: ${ref.path} has no marker <!-- ${ref.name} -->`;
  }
  return ref.name === '' || source.includes(`'${ref.name}'`)
    ? undefined
    : `\`${id}\`: ${ref.path} has no check '${ref.name}'`;
}

/**
 * Test IDs named after a threat: Vitest and Playwright titles starting with `THR-<NN>`, Rust
 * test functions starting with `thr<NN>_`, and the capabilities of L2 scenarios whose
 * description starts with `THR-<NN>`.
 * @param {Inventory} inventory
 * @returns {Array<{ threat: string, test: string }>}
 */
export function namedTests(inventory) {
  /** @type {Array<{ threat: string, test: string }>} */
  const found = [];
  for (const [file, source] of inventory.files) {
    if (file.endsWith('.rs')) {
      for (const match of source.matchAll(/\bfn\s+(thr([0-9]{2})_\w+)\s*\(/g)) {
        const [, name = '', nn = ''] = match;
        if (hasRustTest(source, name))
          found.push({ threat: `THR-${nn}`, test: `rust:${file}::${name}` });
      }
      continue;
    }
    const kind = file.endsWith('.e2e.ts') ? 'l4' : 'vitest';
    for (const match of source.matchAll(
      /\b(?:it|test)(?:\.\w+(?:\([^)]*\))?)*\(\s*(['"`])(THR-([0-9]{2})\b[^'"`]*)\1/g,
    )) {
      const [, , title = '', nn = ''] = match;
      found.push({ threat: `THR-${nn}`, test: `${kind}:${file}::${title}` });
    }
  }
  for (const scenario of inventory.scenarios) {
    const nn = /^THR-([0-9]{2})\b/.exec(scenario.description)?.[1];
    if (nn === undefined) continue;
    for (const capability of scenario.capabilities) {
      found.push({ threat: `THR-${nn}`, test: `cap:${capability}` });
    }
  }
  return found;
}

/**
 * Every check of the map against the architecture rows and the inventory.
 * @param {Threat[]} threats
 * @param {ThreatRow[]} rows
 * @param {Inventory} inventory
 * @returns {string[]}
 */
export function checkThreats(threats, rows, inventory) {
  /** @type {string[]} */
  const problems = [];
  if (rows.length === 0) problems.push('architecture section 10.1 has no threat table');
  for (const row of rows) {
    const threat = threats.find((t) => t.title === row.name);
    if (threat === undefined) {
      problems.push(`section 10.1 row "${row.name}" has no THR entry with that title`);
      continue;
    }
    const mapped = new Set(
      threat.countermeasures.map((c) => c.arch).filter((a) => a !== undefined),
    );
    for (const measure of row.measures.filter((m) => !mapped.has(m))) {
      problems.push(`${threat.id}: the countermeasure "${measure}" of section 10.1 is not mapped`);
    }
    for (const arch of [...mapped].filter((a) => !row.measures.includes(a))) {
      problems.push(`${threat.id}: "${arch}" is not a countermeasure of the section 10.1 row`);
    }
  }
  for (const threat of threats.filter((t) => !rows.some((r) => r.name === t.title))) {
    problems.push(`${threat.id}: "${threat.title}" is not a row of section 10.1`);
  }
  for (const threat of threats) {
    if (!threat.countermeasures.some((c) => c.tests.length > 0)) {
      problems.push(`${threat.id}: no test at all`);
    }
    for (const c of threat.countermeasures) {
      for (const id of c.tests) {
        const problem = resolveTest(id, inventory);
        if (problem !== undefined) problems.push(`${threat.id} (${c.measure}): ${problem}`);
      }
      if (c.type === 'deferred' && c.task !== undefined) {
        const status = inventory.tasks.get(c.task);
        if (status === undefined) problems.push(`${threat.id} (${c.measure}): no task ${c.task}`);
        else if (status === '已完成') {
          problems.push(
            `${threat.id} (${c.measure}): ${c.task} is done; map the tests it added and drop "deferred"`,
          );
        }
      }
    }
  }
  for (const { threat, test } of namedTests(inventory)) {
    const owner = threats.find((t) => t.id === threat);
    if (!owner?.countermeasures.some((c) => c.tests.includes(test))) {
      problems.push(`${test} is named after ${threat} but not mapped to it`);
    }
  }
  return problems;
}

const KIND_LABEL = /** @type {Record<string, string>} */ ({
  cap: 'L2',
  rust: 'Rust',
  vitest: 'Vitest',
  l4: 'L4',
  ci: 'CI',
  process: '流程',
});

const TYPE_LABEL = /** @type {Record<string, string>} */ ({
  automated: '自动化',
  process: '流程',
  'accepted-risk': '已接受风险',
  deferred: '待补',
});

/** @param {string} value */
function cell(value) {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * One test ID for the doc, with the L2 scenarios of a capability and their result.
 * @param {string} id
 * @param {Inventory} inventory
 * @param {ScenarioResult[]} results
 */
function describeTest(id, inventory, results) {
  const ref = parseTestId(id);
  if (ref === undefined) return `\`${id}\``;
  if (ref.kind === 'cap') {
    const scenarios = inventory.scenarios
      .filter((s) => s.capabilities.includes(ref.name))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => {
        const result = results.find((r) => r.id === s.id);
        const only = s.platforms.length < 2 ? `仅 ${s.platforms.join('、')}` : '';
        const failed = result?.status === 'failed' ? '失败' : '';
        const note = [only, failed].filter((n) => n !== '').join('，');
        return note === '' ? `\`${s.id}\`` : `\`${s.id}\`（${note}）`;
      });
    return `L2 ${ref.name}：${scenarios.join('、')}`;
  }
  const where = ref.name === '' ? `\`${ref.path}\`` : `\`${ref.path}\` · ${ref.name}`;
  return `${KIND_LABEL[ref.kind] ?? ref.kind} ${where}`;
}

/**
 * docs/security/threat-coverage.md. Depends only on the map, the inventory and the L2 results
 * (not on timings or the platform the report came from), so a green run gives the same file
 * everywhere.
 * @param {Threat[]} threats
 * @param {Inventory} inventory
 * @param {ScenarioResult[]} results
 * @returns {string}
 */
export function renderCoverage(threats, inventory, results) {
  const sorted = [...threats].sort((a, b) => a.id.localeCompare(b.id));
  const count = (/** @type {Threat} */ t, /** @type {string} */ type) =>
    String(t.countermeasures.filter((c) => c.type === type).length);
  const lines = [
    '# 威胁覆盖',
    '',
    '> 由 `node scripts/ci/check-threats.mjs --results target/l2/results.json --doc write` 根据 `tests/security/threats.yaml`、架构第 10.1 节与 L2 场景结果生成，不要手工编辑。新增安全对策的登记方法见 `docs/engineering/testing.md` 第 16 节。',
    '',
    '测试 ID 的种类：**L2** = 能力 ID 与覆盖它的场景（verify 第 14 步）；**Rust** = `cargo test`（verify 第 8 步）；**Vitest** = verify 第 5 步；**L4** = Playwright（CI `desktop` 作业）；**CI** = 打包产物上的检查脚本（CI `desktop` 作业）；**流程** = PR 模板等人工检查项。对策类型：**自动化**、**流程**、**已接受风险**（写明理由与 ADR 或登记事项）、**待补**（由所列任务补测试）。',
    '',
    '## 汇总',
    '',
    '| 编号 | 威胁 | 对策 | 自动化 | 流程 | 已接受风险 | 待补 | 测试 ID |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const t of sorted) {
    const tests = new Set(t.countermeasures.flatMap((c) => c.tests));
    lines.push(
      `| ${t.id} | ${cell(t.title)} | ${String(t.countermeasures.length)} | ${count(t, 'automated')} | ${count(t, 'process')} | ${count(t, 'accepted-risk')} | ${count(t, 'deferred')} | ${String(tests.size)} |`,
    );
  }
  for (const t of sorted) {
    lines.push('', `## ${t.id} ${t.title}`, '', '| 对策 | 类型 | 测试与依据 |', '|---|---|---|');
    for (const c of t.countermeasures) {
      const evidence = [
        ...c.tests.map((id) => describeTest(id, inventory, results)),
        ...(c.reason === undefined ? [] : [`理由：${c.reason}`]),
        ...(c.task === undefined ? [] : [`由 ${c.task} 补测试`]),
        ...(c.refs.length === 0 ? [] : [`依据：${c.refs.join('、')}`]),
      ];
      lines.push(
        `| ${cell(c.measure)} | ${TYPE_LABEL[c.type] ?? c.type} | ${evidence.map(cell).join('<br>')} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
