import { describe, expect, it } from 'vitest';
import { checkCrateDeps, parseRules, workspaceGraph } from './check-crate-deps.mjs';

const rawRules = {
  layers: [
    { name: 'binding', crates: ['napi'], mayDependOn: ['core', 'foundation'] },
    { name: 'core', crates: ['core'], mayDependOn: ['feature', 'foundation'] },
    {
      name: 'feature',
      crates: ['policy', 'hooks', 'fs', 'checkpoint'],
      mayDependOn: ['foundation'],
    },
    { name: 'foundation', crates: ['protocol', 'ports'], mayDependOn: [] },
  ],
  exceptions: [{ from: 'fs', to: 'checkpoint', reason: 'writes snapshot first' }],
};

/**
 * @param {Record<string, { name: string, kind?: string | null }[]>} deps
 */
function metadata(deps) {
  const names = Object.keys(deps);
  return {
    workspace_members: names.map((name) => `path+file:///ws/${name}#0.0.0`),
    packages: names.map((name) => ({
      id: `path+file:///ws/${name}#0.0.0`,
      name,
      dependencies: deps[name],
    })),
  };
}

const members = ['napi', 'core', 'policy', 'hooks', 'fs', 'checkpoint', 'protocol', 'ports'];

/**
 * @param {Record<string, { name: string, kind?: string | null }[]>} overrides
 */
function graphWith(overrides) {
  /** @type {Record<string, { name: string, kind?: string | null }[]>} */
  const deps = {};
  for (const name of members) {
    deps[name] = overrides[name] ?? [];
  }
  return workspaceGraph(metadata(deps));
}

function rules() {
  const parsed = parseRules(rawRules);
  if (parsed.rules === null) {
    throw new Error(parsed.errors.join('\n'));
  }
  return parsed.rules;
}

describe('workspaceGraph', () => {
  it('keeps only edges between workspace members and records the kind', () => {
    const graph = workspaceGraph(
      metadata({
        core: [
          { name: 'policy', kind: null },
          { name: 'serde', kind: null },
          { name: 'protocol', kind: 'dev' },
        ],
        policy: [{ name: 'protocol', kind: 'build' }],
        protocol: [],
      }),
    );
    expect(graph.members).toEqual(['core', 'policy', 'protocol']);
    expect(graph.edges).toEqual([
      { from: 'core', to: 'policy', kind: 'normal' },
      { from: 'core', to: 'protocol', kind: 'dev' },
      { from: 'policy', to: 'protocol', kind: 'build' },
    ]);
  });
});

describe('checkCrateDeps', () => {
  it('accepts the layered chain and registered exceptions', () => {
    const graph = graphWith({
      napi: [{ name: 'core' }, { name: 'protocol' }],
      core: [{ name: 'policy' }, { name: 'fs' }, { name: 'ports' }],
      fs: [{ name: 'checkpoint' }, { name: 'ports' }],
      policy: [{ name: 'protocol' }],
    });
    expect(checkCrateDeps(rules(), graph)).toEqual([]);
  });

  it('rejects a dependency between feature crates and names both crates', () => {
    const problems = checkCrateDeps(rules(), graphWith({ policy: [{ name: 'hooks' }] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('policy depends on hooks (normal dependency)');
    expect(problems[0]).toContain('layer "feature"');
  });

  it('applies the rules to dev dependencies too', () => {
    const problems = checkCrateDeps(
      rules(),
      graphWith({ hooks: [{ name: 'policy', kind: 'dev' }] }),
    );
    expect(problems).toEqual([expect.stringContaining('hooks depends on policy (dev dependency)')]);
  });

  it('rejects upward and layer-skipping edges', () => {
    const problems = checkCrateDeps(
      rules(),
      graphWith({ protocol: [{ name: 'core' }], napi: [{ name: 'policy' }] }),
    );
    expect(problems).toEqual([
      expect.stringContaining('napi depends on policy'),
      expect.stringContaining('protocol depends on core'),
    ]);
  });

  it('treats exceptions as one-way', () => {
    const problems = checkCrateDeps(rules(), graphWith({ checkpoint: [{ name: 'fs' }] }));
    expect(problems).toEqual([expect.stringContaining('checkpoint depends on fs')]);
  });

  it('reports workspace members without a layer and stale rule entries', () => {
    const graph = workspaceGraph(
      metadata({
        ...Object.fromEntries(members.filter((m) => m !== 'ports').map((m) => [m, []])),
        extra: [],
      }),
    );
    const problems = checkCrateDeps(rules(), graph);
    expect(problems).toContain('extra is a workspace member but has no layer in deps-rules.json');
    expect(problems).toContain('ports is listed in deps-rules.json but is not a workspace member');
  });
});

describe('parseRules', () => {
  it('requires a reason for every exception', () => {
    const result = parseRules({
      ...rawRules,
      exceptions: [{ from: 'fs', to: 'checkpoint', reason: ' ' }],
    });
    expect(result.rules).toBeNull();
    expect(result.errors).toEqual(['exceptions[0] needs "from", "to" and a non-empty "reason"']);
  });

  it('reports references to unknown layers', () => {
    const parsed = parseRules({
      layers: [{ name: 'feature', crates: ['fs'], mayDependOn: ['missing'] }],
      exceptions: [],
    });
    expect(parsed.rules).not.toBeNull();
    if (parsed.rules !== null) {
      const problems = checkCrateDeps(parsed.rules, workspaceGraph(metadata({ fs: [] })));
      expect(problems).toEqual(['Layer "feature" refers to unknown layer "missing"']);
    }
  });
});
