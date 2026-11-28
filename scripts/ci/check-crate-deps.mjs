// Checks dependency directions between workspace crates against
// crates/deps-rules.json (architecture section 7.1).
//
// Usage: node scripts/ci/check-crate-deps.mjs
// Exit code 0 when every edge is allowed, 1 on violations or invalid rules.
import path from 'node:path';
import { capture, isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

/**
 * @typedef {{ name: string, crates: string[], mayDependOn: string[] }} Layer
 * @typedef {{ from: string, to: string, reason: string }} Exception
 * @typedef {{ layers: Layer[], exceptions: Exception[] }} Rules
 * @typedef {{ from: string, to: string, kind: 'normal' | 'dev' | 'build' }} Edge
 */

export const rulesPath = path.join(repoRoot, 'crates', 'deps-rules.json');

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validates the shape of deps-rules.json.
 * @param {unknown} raw
 * @returns {{ rules: Rules | null, errors: string[] }}
 */
export function parseRules(raw) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(raw) || !Array.isArray(raw.layers) || !Array.isArray(raw.exceptions)) {
    return { rules: null, errors: ['deps-rules.json must have "layers" and "exceptions" arrays'] };
  }
  /** @type {Layer[]} */
  const layers = [];
  for (const [index, layer] of raw.layers.entries()) {
    if (
      !isRecord(layer) ||
      typeof layer.name !== 'string' ||
      !isStringArray(layer.crates) ||
      !isStringArray(layer.mayDependOn)
    ) {
      errors.push(`layers[${String(index)}] needs "name", "crates" and "mayDependOn"`);
      continue;
    }
    layers.push({ name: layer.name, crates: layer.crates, mayDependOn: layer.mayDependOn });
  }
  /** @type {Exception[]} */
  const exceptions = [];
  for (const [index, exception] of raw.exceptions.entries()) {
    if (
      !isRecord(exception) ||
      typeof exception.from !== 'string' ||
      typeof exception.to !== 'string' ||
      typeof exception.reason !== 'string' ||
      exception.reason.trim() === ''
    ) {
      errors.push(`exceptions[${String(index)}] needs "from", "to" and a non-empty "reason"`);
      continue;
    }
    exceptions.push({ from: exception.from, to: exception.to, reason: exception.reason });
  }
  return { rules: errors.length === 0 ? { layers, exceptions } : null, errors };
}

/**
 * Extracts edges between workspace crates from `cargo metadata` output.
 * @param {unknown} metadata
 * @returns {{ members: string[], edges: Edge[] }}
 */
export function workspaceGraph(metadata) {
  if (
    !isRecord(metadata) ||
    !Array.isArray(metadata.packages) ||
    !isStringArray(metadata.workspace_members)
  ) {
    throw new Error('Unexpected cargo metadata format');
  }
  const memberIds = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter(
    /** @returns {pkg is Record<string, unknown>} */
    (pkg) => isRecord(pkg) && typeof pkg.id === 'string' && memberIds.has(pkg.id),
  );
  const members = packages.map((pkg) => String(pkg.name));
  const memberNames = new Set(members);
  /** @type {Edge[]} */
  const edges = [];
  for (const pkg of packages) {
    const dependencies = Array.isArray(pkg.dependencies) ? pkg.dependencies : [];
    for (const dep of dependencies) {
      if (!isRecord(dep) || typeof dep.name !== 'string' || !memberNames.has(dep.name)) {
        continue;
      }
      const kind = dep.kind === 'dev' ? 'dev' : dep.kind === 'build' ? 'build' : 'normal';
      edges.push({ from: String(pkg.name), to: dep.name, kind });
    }
  }
  return { members, edges };
}

/**
 * Checks the rules against the workspace and returns readable problems.
 * @param {Rules} rules
 * @param {{ members: string[], edges: Edge[] }} graph
 * @returns {string[]}
 */
export function checkCrateDeps(rules, graph) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, Layer>} */
  const layerOf = new Map();
  const layerNames = new Set(rules.layers.map((layer) => layer.name));
  for (const layer of rules.layers) {
    for (const target of layer.mayDependOn) {
      if (!layerNames.has(target)) {
        problems.push(`Layer "${layer.name}" refers to unknown layer "${target}"`);
      }
    }
    for (const crate of layer.crates) {
      const existing = layerOf.get(crate);
      if (existing !== undefined) {
        problems.push(`${crate} is listed in both layer "${existing.name}" and "${layer.name}"`);
      }
      layerOf.set(crate, layer);
    }
  }

  const members = new Set(graph.members);
  for (const member of graph.members) {
    if (!layerOf.has(member)) {
      problems.push(`${member} is a workspace member but has no layer in deps-rules.json`);
    }
  }
  for (const crate of layerOf.keys()) {
    if (!members.has(crate)) {
      problems.push(`${crate} is listed in deps-rules.json but is not a workspace member`);
    }
  }

  const exceptionKeys = new Set();
  for (const exception of rules.exceptions) {
    for (const crate of [exception.from, exception.to]) {
      if (!layerOf.has(crate)) {
        problems.push(
          `Exception ${exception.from} -> ${exception.to} names unknown crate ${crate}`,
        );
      }
    }
    exceptionKeys.add(`${exception.from}\u0000${exception.to}`);
  }

  for (const edge of graph.edges) {
    const fromLayer = layerOf.get(edge.from);
    const toLayer = layerOf.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined) {
      continue; // already reported as a missing layer above
    }
    const allowedByLayer = fromLayer !== toLayer && fromLayer.mayDependOn.includes(toLayer.name);
    if (allowedByLayer || exceptionKeys.has(`${edge.from}\u0000${edge.to}`)) {
      continue;
    }
    const allowed =
      fromLayer.mayDependOn.length === 0
        ? 'no layer'
        : `layers [${fromLayer.mayDependOn.join(', ')}]`;
    problems.push(
      `${edge.from} depends on ${edge.to} (${edge.kind} dependency), which is not allowed: ` +
        `${edge.from} is in layer "${fromLayer.name}" and may depend on ${allowed}, ` +
        `${edge.to} is in layer "${toLayer.name}", and no exception is registered`,
    );
  }
  return problems;
}

async function main() {
  const { rules, errors } = parseRules(readJsonFile(rulesPath));
  if (rules === null) {
    for (const error of errors) {
      console.error(`✗ ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  const metadata = await capture('cargo', ['metadata', '--format-version', '1', '--no-deps']);
  const graph = workspaceGraph(JSON.parse(metadata));
  const problems = checkCrateDeps(rules, graph);
  if (problems.length > 0) {
    console.error(`Crate dependency check failed (${String(problems.length)} problem(s)):`);
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    console.error(`Rules: ${path.relative(repoRoot, rulesPath)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Crate dependency check passed: ${String(graph.members.length)} crates, ` +
      `${String(graph.edges.length)} internal edge(s), ${String(rules.exceptions.length)} exception(s).`,
  );
}

if (isMain(import.meta.url)) {
  await main();
}
