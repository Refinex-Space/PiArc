// The capability list (tests/capabilities.yaml) and its checks (architecture section 12.4,
// docs/engineering/testing.md section 13): the list itself, coverage by the L2 report,
// milestone gates, and the generated docs/product/capabilities.md.
import { parse } from 'yaml';

import { isRecord } from './repo.mjs';

export const MILESTONES = ['M1', 'M2', 'M3', 'M4', 'M5'];
export const STATUSES = ['planned', 'active', 'blocked'];
const ID = /^CAP-[A-Z0-9]+(-[A-Z0-9]+)*-[0-9]{3}$/;
const FR = /^FR-[A-Z]{2}-[0-9]{2}$/;
const ARCH = /^ARCH-([0-9]+(\.[0-9]+)*)$/;

/**
 * @typedef {{ id: string, title: string, milestone: string, refs: string[], task: string,
 *   status: string, reason?: string, link?: string }} Capability
 * @typedef {{ ref: string, reason: string, task: string }} ClientOnly
 * @typedef {{ capabilities: Capability[], clientOnly: ClientOnly[] }} Catalog
 * @typedef {{ id: string, file: string, capabilities: string[], platforms: string[],
 *   status: string, skip_reason?: string }} ScenarioResult
 * @typedef {{ filtered: boolean, platform: string | null, scenarios: ScenarioResult[] }} L2Report
 */

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {string | undefined}
 */
function str(object, key) {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function strings(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? /** @type {string[]} */ (value)
    : undefined;
}

/**
 * Parses tests/capabilities.yaml; shape problems are returned, not thrown.
 * @param {string} text
 * @returns {{ catalog: Catalog, problems: string[] }}
 */
export function parseCatalog(text) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Catalog} */
  const catalog = { capabilities: [], clientOnly: [] };
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return {
      catalog,
      problems: [`capabilities.yaml: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(doc) || !Array.isArray(doc.capabilities)) {
    return { catalog, problems: ['capabilities.yaml: `capabilities` must be a list'] };
  }
  const allowed = new Set(['id', 'title', 'milestone', 'refs', 'task', 'status', 'reason', 'link']);
  for (const [n, entry] of doc.capabilities.entries()) {
    const where = `capabilities[${String(n)}]`;
    if (!isRecord(entry)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    for (const key of Object.keys(entry).filter((k) => !allowed.has(k))) {
      problems.push(`${where}: unknown field \`${key}\``);
    }
    const id = str(entry, 'id');
    const title = str(entry, 'title');
    const milestone = str(entry, 'milestone');
    const refs = strings(entry.refs);
    const task = str(entry, 'task');
    const status = str(entry, 'status');
    const missing = Object.entries({ id, title, milestone, refs, task, status })
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    if (missing.length > 0 || !id || !title || !milestone || !refs || !task || !status) {
      problems.push(`${id ?? where}: missing or invalid ${missing.join(', ')}`);
      continue;
    }
    /** @type {Capability} */
    const capability = { id, title, milestone, refs, task, status };
    const reason = str(entry, 'reason');
    const link = str(entry, 'link');
    if (reason !== undefined) capability.reason = reason;
    if (link !== undefined) capability.link = link;
    catalog.capabilities.push(capability);
  }
  const clientOnly = doc.client_only ?? [];
  if (!Array.isArray(clientOnly)) {
    problems.push('capabilities.yaml: `client_only` must be a list');
  } else {
    for (const [n, entry] of clientOnly.entries()) {
      const ref = isRecord(entry) ? str(entry, 'ref') : undefined;
      const reason = isRecord(entry) ? str(entry, 'reason') : undefined;
      const task = isRecord(entry) ? str(entry, 'task') : undefined;
      if (!ref || !reason || !task) {
        problems.push(`client_only[${String(n)}]: needs ref, reason and task`);
        continue;
      }
      catalog.clientOnly.push({ ref, reason, task });
    }
  }
  return { catalog, problems };
}

/**
 * Requirement ids of chapter 4 of REQUIREMENTS.md (table rows starting with an FR id).
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function requirementIds(markdown) {
  return new Set([...markdown.matchAll(/^\| (FR-[A-Z]{2}-[0-9]{2}) \|/gm)].map((m) => m[1] ?? ''));
}

/**
 * Section numbers of ARCHITECTURE.md headings (`6`, `6.1`, `6.1.2`).
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function architectureSections(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{2,4} ([0-9]+(?:\.[0-9]+)*)\.? /gm)].map((m) => m[1] ?? ''),
  );
}

/**
 * Checks the list itself: ids, milestones, statuses, blocked entries, references, and that
 * every requirement of chapter 4 is a capability's ref or client-only.
 * @param {Catalog} catalog
 * @param {{ requirements: Set<string>, sections: Set<string> }} sources
 * @returns {string[]}
 */
export function checkCatalog(catalog, sources) {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const c of catalog.capabilities) {
    if (!ID.test(c.id)) problems.push(`${c.id}: id must look like CAP-<DOMAIN>-<NAME>-<NNN>`);
    if (seen.has(c.id)) problems.push(`${c.id}: listed twice`);
    seen.add(c.id);
    if (!MILESTONES.includes(c.milestone)) problems.push(`${c.id}: milestone ${c.milestone}`);
    if (!STATUSES.includes(c.status)) problems.push(`${c.id}: status ${c.status}`);
    if (c.status === 'blocked' && (!c.reason || !c.link)) {
      problems.push(`${c.id}: blocked needs \`reason\` and \`link\``);
    }
    if (c.status !== 'blocked' && (c.reason || c.link)) {
      problems.push(`${c.id}: \`reason\` and \`link\` belong to blocked capabilities`);
    }
    if (c.refs.length === 0) problems.push(`${c.id}: refs is empty`);
    problems.push(...checkRefs(c.id, c.refs, sources));
  }
  const covered = new Set(catalog.capabilities.flatMap((c) => c.refs));
  for (const entry of catalog.clientOnly) {
    if (!sources.requirements.has(entry.ref)) {
      problems.push(`client_only ${entry.ref}: not a requirement of chapter 4`);
    }
    covered.add(entry.ref);
  }
  for (const fr of sources.requirements) {
    if (!covered.has(fr))
      problems.push(`${fr}: no capability refers to it and it is not client_only`);
  }
  return problems;
}

/**
 * @param {string} id
 * @param {string[]} refs
 * @param {{ requirements: Set<string>, sections: Set<string> }} sources
 * @returns {string[]}
 */
function checkRefs(id, refs, sources) {
  return refs.flatMap((ref) => {
    if (FR.test(ref)) {
      return sources.requirements.has(ref) ? [] : [`${id}: ${ref} is not a requirement`];
    }
    const section = ARCH.exec(ref)?.[1];
    if (section !== undefined) {
      return sources.sections.has(section) ? [] : [`${id}: ${ref} is not an architecture section`];
    }
    return [`${id}: ref ${ref} is neither FR-… nor ARCH-<section>`];
  });
}

/**
 * Coverage by the L2 report: active capabilities without a scenario are MISSING; scenarios
 * may only name listed capabilities. A filtered report is rejected.
 * @param {Catalog} catalog
 * @param {L2Report} report
 * @returns {{ missing: string[], problems: string[] }}
 */
export function checkCoverage(catalog, report) {
  /** @type {string[]} */
  const problems = [];
  if (report.filtered) {
    problems.push('the L2 report comes from a filtered run; coverage needs every scenario');
  }
  const known = new Set(catalog.capabilities.map((c) => c.id));
  for (const scenario of report.scenarios) {
    for (const id of scenario.capabilities.filter((id) => !known.has(id))) {
      problems.push(`${scenario.file}: capability ${id} is not in tests/capabilities.yaml`);
    }
  }
  const covering = scenariosByCapability(report);
  const missing = catalog.capabilities
    .filter((c) => c.status === 'active' && (covering.get(c.id) ?? []).length === 0)
    .map((c) => c.id);
  return { missing, problems };
}

/**
 * @param {L2Report} report
 * @returns {Map<string, ScenarioResult[]>}
 */
function scenariosByCapability(report) {
  /** @type {Map<string, ScenarioResult[]>} */
  const map = new Map();
  for (const scenario of report.scenarios) {
    for (const id of scenario.capabilities) {
      map.set(id, [...(map.get(id) ?? []), scenario]);
    }
  }
  return map;
}

/** @param {string} text */
function cell(text) {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * The state shown for a capability.
 * @param {Capability} c
 * @param {ScenarioResult[]} scenarios
 */
function stateOf(c, scenarios) {
  if (c.status === 'blocked') return `BLOCKED：${c.reason ?? ''}（${c.link ?? ''}）`;
  if (scenarios.some((s) => s.status === 'failed')) return '失败';
  if (c.status === 'planned') return '计划中';
  return scenarios.length === 0 ? 'MISSING' : '已实现';
}

/**
 * docs/product/capabilities.md. Depends only on the list and the scenarios (not on timings or
 * on the platform the report came from), so a green run gives the same file everywhere.
 * @param {Catalog} catalog
 * @param {L2Report} report
 * @returns {string}
 */
export function renderDoc(catalog, report) {
  const covering = scenariosByCapability(report);
  const lines = [
    '# 能力清单',
    '',
    '> 由 `node scripts/ci/check-capabilities.mjs --results <L2 报告> --doc write` 根据 `tests/capabilities.yaml` 与 L2 场景结果生成，不要手工编辑。格式与规则见 `docs/engineering/testing.md` 第 13 节。',
    '',
    '状态：**已实现** = `active` 且至少一个 L2 场景覆盖；**计划中** = `planned`；**BLOCKED** = 因外部原因暂缓；**MISSING** = `active` 却没有场景；**失败** = 覆盖它的场景没有通过。',
    '',
    '## 汇总',
    '',
    '| 里程碑 | 能力数 | 已实现 | 计划中 | BLOCKED |',
    '|---|---|---|---|---|',
  ];
  for (const m of MILESTONES) {
    const of = catalog.capabilities.filter((c) => c.milestone === m);
    const count = (/** @type {string} */ s) => String(of.filter((c) => c.status === s).length);
    lines.push(
      `| ${m} | ${String(of.length)} | ${count('active')} | ${count('planned')} | ${count('blocked')} |`,
    );
  }
  for (const m of MILESTONES) {
    lines.push(
      '',
      `## ${m}`,
      '',
      '| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |',
      '|---|---|---|---|---|---|',
    );
    const rows = catalog.capabilities
      .filter((c) => c.milestone === m)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const c of rows) {
      const scenarios = [...(covering.get(c.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
      const names = scenarios.map((s) =>
        s.platforms.length < 2 ? `\`${s.id}\`（仅 ${s.platforms.join('、')}）` : `\`${s.id}\``,
      );
      lines.push(
        `| ${c.id} | ${cell(c.title)} | ${c.refs.join('、')} | ${c.task} | ${names.join('<br>') || '—'} | ${cell(stateOf(c, scenarios))} |`,
      );
    }
  }
  lines.push(
    '',
    '## 由客户端测试（L4）验证的需求',
    '',
    '| 需求 | 原因 | 任务 |',
    '|---|---|---|',
    ...[...catalog.clientOnly]
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map((e) => `| ${e.ref} | ${cell(e.reason)} | ${e.task} |`),
    '',
  );
  return lines.join('\n');
}

/**
 * Narrows the parsed L2 report.
 * @param {unknown} value
 * @returns {L2Report}
 */
export function toReport(value) {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) {
    throw new Error('the L2 report has no `scenarios` list');
  }
  const scenarios = value.scenarios.map((s, n) => {
    if (!isRecord(s)) throw new Error(`scenarios[${String(n)}] is not an object`);
    const id = str(s, 'id');
    const file = str(s, 'file');
    const status = str(s, 'status');
    const capabilities = strings(s.capabilities);
    const platforms = strings(s.platforms);
    if (!id || !file || !status || !capabilities || !platforms) {
      throw new Error(`scenarios[${String(n)}] lacks id, file, status, capabilities or platforms`);
    }
    return { id, file, status, capabilities, platforms };
  });
  return {
    filtered: value.filtered === true,
    platform: typeof value.platform === 'string' ? value.platform : null,
    scenarios,
  };
}
