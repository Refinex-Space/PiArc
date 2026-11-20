import { describe, expect, it } from 'vitest';

import { applyAllowlist, parseAllowlist, satisfies } from './allowlist.mjs';
import { compilePattern, diff } from './diff.mjs';
import { normalize } from './normalize.mjs';
import { FORMAT, scrubPaths } from './recording.mjs';
import { coverageProblems, parseArgs } from './run.mjs';
import { PARAMETERS, toCanonical, toPiarc } from './scenario.mjs';

/**
 * @param {Partial<import('./recording.mjs').Recording['trace']>} trace
 * @param {'piarc' | 'claude-code'} [side]
 * @returns {import('./recording.mjs').Recording}
 */
function recording(trace, side = 'claude-code') {
  return {
    format: FORMAT,
    side,
    version: '1',
    scenario: 's',
    run: { exit: 0, failures: [] },
    requests: [],
    trace: {
      tool_calls: [],
      asks: [],
      hooks: [],
      final: { status: 'completed' },
      files: {},
      ...trace,
    },
  };
}

describe('diff', () => {
  it('lists differences by field path', () => {
    expect(
      diff(
        { a: { b: 1, 'x.y': [1, 2] }, list: [{ c: 1 }], same: 'v' },
        { a: { b: 2, 'x.y': [1, 2] }, list: [{ c: 1 }, { c: 2 }], same: 'v' },
      ),
    ).toEqual([
      { path: 'a.b', piarc: 1, claude: 2 },
      { path: 'list[1]', piarc: undefined, claude: { c: 2 } },
    ]);
    expect(diff({ files: { 'notes.txt': 'h1' } }, { files: { 'notes.txt': 'h2' } })[0]?.path).toBe(
      'files["notes.txt"]',
    );
  });

  it('matches allowlist patterns', () => {
    expect(
      compilePattern('requests.items[*].tools.Agent').test('requests.items[3].tools.Agent'),
    ).toBe(true);
    expect(compilePattern('requests.items[*].tools.*').test('requests.items[0].tools.Grep')).toBe(
      true,
    );
    expect(
      compilePattern('requests.items[*].tools.*').test('requests.items[0].tools.Read.params'),
    ).toBe(false);
    expect(compilePattern('hooks.calls["*"].fields').test('hooks.calls["end#0"].fields')).toBe(
      true,
    );
    expect(compilePattern('requests.**').test('requests.items[0].keys')).toBe(true);
  });
});

describe('allowlist', () => {
  const text = `
differences:
  - { scenario: '*', path: 'final.status', claude_code: '>=2.1.0 <2.2.0', reason: Intended. }
  - { scenario: perm-*, path: 'asks', claude_code: '*', reason: Intended too. }
  - { scenario: hooks-a, path: 'files', claude_code: '*', reason: Not used here. }
  - { scenario: '*', path: 'x', claude_code: '>=3.0.0', reason: Other versions. }
excluded:
  - { scenario: perm-x, reason: Cannot run headless. }
`;

  it('rejects entries without a reason and malformed ranges', () => {
    const { problems } = parseAllowlist(`
differences:
  - { scenario: s, path: p, claude_code: 'soon', reason: '' }
excluded:
  - { scenario: e }
`);
    expect(problems).toEqual([
      'differences[0] (p): the reason is missing',
      'differences[0]: claude_code `soon` is not a version range',
      'excluded[0] (e): the reason is missing',
    ]);
  });

  it('splits allowed from unexplained and finds stale entries', () => {
    const { allowlist, problems } = parseAllowlist(text);
    expect(problems).toEqual([]);
    const differences = new Map([
      [
        'perm-a',
        [
          { path: 'final.status', piarc: 'a', claude: 'b' },
          { path: 'asks', piarc: [], claude: ['x'] },
        ],
      ],
      ['hooks-a', [{ path: 'tool_calls.order', piarc: [], claude: ['t'] }]],
    ]);
    const { results, stale } = applyAllowlist(allowlist, '2.1.318', differences);
    expect(results.get('perm-a')?.unexplained).toEqual([]);
    expect(results.get('perm-a')?.allowed.map((a) => a.entry.index)).toEqual([0, 1]);
    expect(results.get('hooks-a')?.unexplained.map((d) => d.path)).toEqual(['tool_calls.order']);
    // Entry 2 applies to hooks-a, which ran, and matched nothing; entry 3 is for other versions.
    expect(stale.map((e) => e.index)).toEqual([2]);
  });

  it('compares versions', () => {
    expect(satisfies('2.1.318', '>=2.1.300 <2.2.0')).toBe(true);
    expect(satisfies('2.2.0', '>=2.1.300 <2.2.0')).toBe(false);
    expect(satisfies('2.1.318', '=2.1.318')).toBe(true);
    expect(satisfies('2.1.318', '*')).toBe(true);
  });
});

describe('normalization', () => {
  it('maps PiArc inputs back to Claude Code parameters', () => {
    for (const [tool, input] of /** @type {[string, Record<string, unknown>][]} */ ([
      ['Read', { file_path: '<WS>/a.txt', offset: 2, limit: 3 }],
      ['Write', { file_path: '<WS>/a.txt', content: 'x' }],
      ['Edit', { file_path: '<WS>/a.txt', old_string: 'a', new_string: 'b' }],
      ['Bash', { command: 'ls', timeout: 5000 }],
    ])) {
      expect(toCanonical(tool, toPiarc(tool, input))).toEqual(input);
    }
    expect(toPiarc('Edit', { file_path: 'f', old_string: 'a', new_string: 'b' })).toEqual({
      path: 'f',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(Object.keys(PARAMETERS)).toEqual(['Read', 'Write', 'Edit', 'Bash']);
  });

  it('replaces absolute paths with placeholders and unifies separators', () => {
    expect(
      scrubPaths({ p: 'C:\\t\\r\\ws\\a\\b.txt', q: '/t/r/home/x', [`/t/r/ws`]: 1 }, [
        ['C:\\t\\r\\ws', '<WS>'],
        ['/t/r/ws', '<WS>'],
        ['/t/r/home', '<HOME>'],
      ]),
    ).toEqual({ p: '<WS>/a/b.txt', q: '<HOME>/x', '<WS>': 1 });
  });

  it('orders the hooks of one event and call by name, whatever order they ran in', () => {
    const hook = (/** @type {string} */ name) => ({
      hook: name,
      event: 'PreToolUse',
      fields: [],
      tool: 'Write',
      tool_use_id: 'w',
      run: 0,
      returned: { exit: 0, decision: null },
    });
    const a = normalize(recording({ hooks: [hook('ask'), hook('allow')] }));
    const b = normalize(recording({ hooks: [hook('allow'), hook('ask')] }));
    expect(a.hooks.order).toEqual(['PreToolUse:allow', 'PreToolUse:ask']);
    expect(diff(a, b)).toEqual([]);
  });
});

describe('run', () => {
  it('parses its arguments', () => {
    expect(parseArgs(['--filter', 'perm', '--repeat', '2'])).toEqual({
      filters: ['perm'],
      repeat: 2,
    });
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument --nope');
  });

  it('requires every compared L2 scenario to be mirrored or excluded', () => {
    /** @type {import('./scenario.mjs').Scenario} */
    const scenario = {
      id: 'perm-a',
      area: 'permissions',
      description: 'd',
      mirrors: ['perm-one'],
      trusted: true,
      workspace: { files: {}, plans: {} },
      prompt: 'p',
      steps: [],
      approvals: [],
    };
    expect(
      coverageProblems(
        [scenario],
        [
          { scenario: 'hooks-two', reason: 'r' },
          { scenario: 'gone', reason: 'r' },
        ],
        ['perm-one', 'hooks-two', 'policy-three', 'chat-basic'],
      ),
    ).toEqual([
      'L2 scenario policy-three is neither mirrored by an L3 scenario nor excluded in tests/l3-allowlist.yaml',
      'excluded scenario gone does not exist',
    ]);
  });
});
