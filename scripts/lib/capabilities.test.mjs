import { describe, expect, it } from 'vitest';

import {
  architectureSections,
  checkCatalog,
  checkCoverage,
  parseCatalog,
  pendingUpTo,
  renderDoc,
  requirementIds,
  taskStatuses,
} from './capabilities.mjs';

const CATALOG = `
version: 1
capabilities:
  - id: CAP-TURN-STEER-001
    title: 'steer'
    milestone: M1
    refs: [FR-CH-03, ARCH-6.15]
    task: T14
    status: active
  - id: CAP-TOOL-EDIT-002
    title: 'edit invariants'
    milestone: M1
    refs: [FR-TL-01]
    task: T16
    status: planned
  - id: CAP-HOOK-PRE-001
    title: 'PreToolUse'
    milestone: M2
    refs: [ARCH-6.3.2]
    task: T25
    status: planned
client_only:
  - { ref: FR-CH-05, reason: 'views', task: T29 }
`;

const SOURCES = {
  requirements: requirementIds(
    '| FR-CH-03 | steer | P0 | M1 |\n| FR-TL-01 | tools | P0 | M1 |\n| FR-CH-05 | views | P1 | M2 |\n',
  ),
  sections: architectureSections('## 6. Harness\n### 6.15 不变量\n#### 6.3.2 事件\n'),
  tasks: taskStatuses(
    [
      '| T14 | [会话](tasks/T14.md) | 2 | T13 | macOS | xhigh | 大 | 无 | 已完成 | eedccea |',
      '| T16 | [文件工具](tasks/T16.md) | 2 | T15 | macOS | xhigh | 大 | 无 | 未开始 | — |',
      '| T25 | [Hooks](tasks/T25.md) | 3 | T24 | macOS | xhigh | 大 | 无 | 未开始 | — |',
      '| T29 | [WebFetch](tasks/T29.md) | 3 | T28 | macOS | high | 中 | 无 | 未开始 | — |',
    ].join('\n'),
  ),
};

/** @param {string} text */
function catalogOf(text) {
  const { catalog, problems } = parseCatalog(text);
  expect(problems).toEqual([]);
  return catalog;
}

/**
 * @param {Array<{ id: string, capabilities: string[], status?: string, platforms?: string[] }>} scenarios
 */
function report(scenarios, filtered = false) {
  return {
    filtered,
    platform: 'macos',
    scenarios: scenarios.map((s) => ({
      file: `tests/scenarios/${s.id}.yaml`,
      status: 'passed',
      platforms: ['macos', 'windows'],
      ...s,
    })),
  };
}

describe('the catalog', () => {
  it('passes with known references, board tasks and every requirement placed', () => {
    expect(checkCatalog(catalogOf(CATALOG), SOURCES)).toEqual([]);
  });

  it('rejects a blocked capability without reason or link', () => {
    const catalog = catalogOf(
      CATALOG.replace('status: planned\n  - id: CAP-HOOK', 'status: blocked\n  - id: CAP-HOOK'),
    );
    expect(checkCatalog(catalog, SOURCES)).toEqual([
      'CAP-TOOL-EDIT-002: blocked needs `reason` and `link`',
    ]);
    const complete = catalogOf(
      CATALOG.replace(
        'status: planned\n  - id: CAP-HOOK',
        "status: blocked\n    reason: 'upstream'\n    link: I99\n  - id: CAP-HOOK",
      ),
    );
    expect(checkCatalog(complete, SOURCES)).toEqual([]);
  });

  it('rejects unknown references, unknown tasks, duplicates and unplaced requirements', () => {
    const catalog = catalogOf(
      CATALOG.replace('[FR-TL-01]', '[FR-TL-09, ARCH-99.1]')
        .replace('task: T25', 'task: T99')
        .replace('CAP-HOOK-PRE-001', 'CAP-TURN-STEER-001'),
    );
    expect(checkCatalog(catalog, SOURCES)).toEqual([
      'CAP-TOOL-EDIT-002: FR-TL-09 is not a requirement',
      'CAP-TOOL-EDIT-002: ARCH-99.1 is not an architecture section',
      'CAP-TURN-STEER-001: listed twice',
      'CAP-TURN-STEER-001: task T99 is not on the board',
      'FR-TL-01: no capability refers to it and it is not client_only',
    ]);
  });

  it('reports a malformed file instead of throwing', () => {
    expect(parseCatalog('capabilities: [').problems[0]).toMatch(/^capabilities\.yaml: /);
  });
});

describe('coverage by the L2 report', () => {
  const catalog = catalogOf(CATALOG);

  it('reports MISSING when every scenario of an active capability is gone', () => {
    expect(
      checkCoverage(catalog, report([{ id: 'turn-steer', capabilities: ['CAP-TURN-STEER-001'] }])),
    ).toEqual({ missing: [], problems: [] });
    expect(checkCoverage(catalog, report([]))).toEqual({
      missing: ['CAP-TURN-STEER-001'],
      problems: [],
    });
  });

  it('does not require scenarios for planned capabilities', () => {
    const result = checkCoverage(
      catalog,
      report([{ id: 'turn-steer', capabilities: ['CAP-TURN-STEER-001'] }]),
    );
    expect(result.missing).not.toContain('CAP-TOOL-EDIT-002');
  });

  it('rejects a scenario naming a capability that is not listed', () => {
    const result = checkCoverage(
      catalog,
      report([{ id: 'turn-steer', capabilities: ['CAP-TURN-STEER-001', 'CAP-TURN-STEER-002'] }]),
    );
    expect(result.problems).toEqual([
      'tests/scenarios/turn-steer.yaml: capability CAP-TURN-STEER-002 is not in tests/capabilities.yaml',
    ]);
  });

  it('rejects a filtered report', () => {
    expect(checkCoverage(catalog, report([], true)).problems[0]).toMatch(/filtered run/);
  });
});

describe('the milestone gate', () => {
  it('lists planned capabilities up to the milestone with their task status', () => {
    const { pending, problems } = pendingUpTo(catalogOf(CATALOG), 'M1', SOURCES.tasks);
    expect(pending.map((c) => `${c.id}:${c.taskStatus}`)).toEqual(['CAP-TOOL-EDIT-002:未开始']);
    expect(problems).toEqual([]);
    expect(pendingUpTo(catalogOf(CATALOG), 'M2', SOURCES.tasks).pending).toHaveLength(2);
  });

  it('flags a planned capability whose task is done', () => {
    const catalog = catalogOf(CATALOG.replace('task: T16', 'task: T14'));
    expect(pendingUpTo(catalog, 'M1', SOURCES.tasks).problems).toEqual([
      'CAP-TOOL-EDIT-002: still planned although T14 is 已完成',
    ]);
  });
});

describe('capabilities.md', () => {
  const catalog = catalogOf(CATALOG);
  const steer = { id: 'turn-steer', capabilities: ['CAP-TURN-STEER-001'] };

  it('is the same for any order of scenarios and on a platform that skipped some', () => {
    const other = { id: 'a-steer-check', capabilities: ['CAP-TURN-STEER-001'] };
    const doc = renderDoc(catalog, report([steer, other]));
    expect(renderDoc(catalog, report([other, steer]))).toBe(doc);
    const skipped = report([steer, { ...other, status: 'skipped' }]);
    expect(renderDoc(catalog, { ...skipped, platform: 'windows' })).toBe(doc);
    expect(doc).toContain(
      '| CAP-TURN-STEER-001 | steer | FR-CH-03、ARCH-6.15 | T14 | `a-steer-check`<br>`turn-steer` | 已实现 |',
    );
    expect(doc).toContain('| CAP-TOOL-EDIT-002 | edit invariants | FR-TL-01 | T16 | — | 计划中 |');
    expect(doc).toContain('| FR-CH-05 | views | T29 |');
  });

  it('shows failing and missing coverage', () => {
    expect(renderDoc(catalog, report([{ ...steer, status: 'failed' }]))).toContain('| 失败 |');
    expect(renderDoc(catalog, report([]))).toContain('| — | MISSING |');
  });
});
