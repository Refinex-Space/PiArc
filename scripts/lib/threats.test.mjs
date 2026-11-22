import { describe, expect, it } from 'vitest';

import {
  checkThreats,
  hasRustTest,
  hasTitledTest,
  parseTestId,
  parseThreats,
  renderCoverage,
  threatRows,
} from './threats.mjs';

const ARCHITECTURE = `
## 10. 安全与合规

### 10.1 威胁模型

| 威胁 | 场景 | 对策 |
|---|---|---|
| 提示注入 | 仓库文件诱导 | 默认询问；沙箱 |
| 供应链 | 依赖被投毒 | 精确版本锁定 |

### 10.2 项目信任
`;

const MAP = `version: 1
threats:
  - id: THR-01
    title: 提示注入
    countermeasures:
      - arch: 默认询问
        measure: 默认询问
        type: automated
        tests: ['rust:crates/a/tests/x.rs::asks_by_default', 'cap:CAP-PERM-MODE-001']
      - arch: 沙箱
        measure: 沙箱
        type: automated
        tests: ['vitest:scripts/a.test.mjs::THR-01 keeps the sandbox']
  - id: THR-08
    title: 供应链
    countermeasures:
      - arch: 精确版本锁定
        measure: 精确版本锁定
        type: automated
        tests: ['l4:apps/desktop/e2e/a.e2e.ts::pins']
      - measure: 新增依赖需评审
        type: process
        reason: 评审在 PR 中完成
        tests: ['process:.github/pull_request_template.md#dependency-review']
      - measure: 更新流程
        type: deferred
        task: T50
        reason: T50 实现更新流程
`;

// Built at run time so the reverse check does not take this file's fixture for a test.
const SANDBOX_TITLE = ['THR', '01 keeps the sandbox'].join('-');

function inventory() {
  return {
    files: new Map([
      ['crates/a/tests/x.rs', '#[test]\nfn asks_by_default() {}\n\nfn helper() {}\n'],
      ['scripts/a.test.mjs', `it('${SANDBOX_TITLE}', () => {});\n`],
      ['apps/desktop/e2e/a.e2e.ts', "test('pins', async () => {});\n"],
      ['.github/pull_request_template.md', '- [ ] <!-- dependency-review --> 新依赖已评审\n'],
    ]),
    capabilities: new Map([['CAP-PERM-MODE-001', 'active']]),
    scenarios: [
      {
        id: 'policy-manual',
        capabilities: ['CAP-PERM-MODE-001'],
        platforms: ['macos'],
        description: 'asks',
      },
    ],
    tasks: new Map([['T50', '未开始']]),
  };
}

describe('threat rows', () => {
  it('reads every row of section 10.1 and splits the countermeasures at the full-width semicolon', () => {
    expect(threatRows(ARCHITECTURE)).toEqual([
      { name: '提示注入', measures: ['默认询问', '沙箱'] },
      { name: '供应链', measures: ['精确版本锁定'] },
    ]);
  });
});

describe('test IDs', () => {
  it('parses each kind', () => {
    expect(parseTestId('rust:crates/a/tests/x.rs::f')).toEqual({
      kind: 'rust',
      path: 'crates/a/tests/x.rs',
      name: 'f',
    });
    expect(parseTestId('cap:CAP-X-001')).toEqual({
      kind: 'cap',
      path: 'tests/capabilities.yaml',
      name: 'CAP-X-001',
    });
    expect(parseTestId('ci:scripts/ci/check.mjs#run-as-node')?.name).toBe('run-as-node');
    expect(parseTestId('ci:scripts/ci/check-fuses.mjs')?.name).toBe('');
    expect(parseTestId('rust:no-name')).toBeUndefined();
    expect(parseTestId('jest:x::y')).toBeUndefined();
  });

  it('finds Rust tests only behind a test attribute', () => {
    const source =
      '#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}\nfn b() {}\n#[test]\nfn c() {}\n';
    expect(hasRustTest(source, 'a')).toBe(true);
    expect(hasRustTest(source, 'c')).toBe(true);
    expect(hasRustTest('fn b() {}\n', 'b')).toBe(false);
  });

  it('finds titled tests, also behind modifiers, but not skipped ones', () => {
    expect(hasTitledTest("it.runIf(x)('works', () => {})", 'works')).toBe(true);
    expect(hasTitledTest('test("works", async () => {})', 'works')).toBe(true);
    expect(hasTitledTest("it.skip('works', () => {})", 'works')).toBe(false);
    expect(hasTitledTest("it('works too', () => {})", 'works')).toBe(false);
  });
});

describe('the threat map', () => {
  it('passes when rows, countermeasures and tests all match', () => {
    const { threats, problems } = parseThreats(MAP);
    expect(problems).toEqual([]);
    expect(checkThreats(threats, threatRows(ARCHITECTURE), inventory())).toEqual([]);
  });

  it('fails when a mapping is removed', () => {
    const { threats } = parseThreats(MAP.replace(/ {6}- arch: 沙箱\n(.*\n){3}/, ''));
    expect(checkThreats(threats, threatRows(ARCHITECTURE), inventory())).toEqual([
      'THR-01: the countermeasure "沙箱" of section 10.1 is not mapped',
      'vitest:scripts/a.test.mjs::THR-01 keeps the sandbox is named after THR-01 but not mapped to it',
    ]);
  });

  it('fails when a referenced test does not exist', () => {
    const { threats } = parseThreats(MAP.replace('::pins', '::pins exactly'));
    expect(checkThreats(threats, threatRows(ARCHITECTURE), inventory())).toEqual([
      'THR-08 (精确版本锁定): `l4:apps/desktop/e2e/a.e2e.ts::pins exactly`: no test titled "pins exactly"',
    ]);
  });

  it('fails when a row has no entry and when a deferred task is already done', () => {
    const { threats } = parseThreats(MAP);
    const found = inventory();
    found.tasks.set('T50', '已完成');
    const rows = [...threatRows(ARCHITECTURE), { name: '新威胁', measures: ['某对策'] }];
    expect(checkThreats(threats, rows, found)).toEqual([
      'section 10.1 row "新威胁" has no THR entry with that title',
      'THR-08 (更新流程): T50 is done; map the tests it added and drop "deferred"',
    ]);
  });

  it('rejects malformed entries', () => {
    const { problems } = parseThreats(
      'version: 1\nthreats:\n  - id: T1\n    title: x\n    countermeasures:\n      - measure: m\n        type: automated\n        tests: []\n        extra: 1\n',
    );
    expect(problems).toEqual([
      'threats[0]: id must be THR-<NN>',
      'T1.countermeasures[0]: unknown field `extra`',
      'T1.countermeasures[0]: an automated countermeasure needs at least one test',
    ]);
  });

  it('renders the same document for the same map and results', () => {
    const { threats } = parseThreats(MAP);
    const doc = renderCoverage(threats, inventory(), [
      { id: 'policy-manual', status: 'passed', platforms: ['macos'] },
    ]);
    expect(doc).toContain('| THR-01 | 提示注入 | 2 | 2 | 0 | 0 | 0 | 3 |');
    expect(doc).toContain('L2 CAP-PERM-MODE-001：`policy-manual`（仅 macos）');
    expect(doc).toContain('| 更新流程 | 待补 | 理由：T50 实现更新流程<br>由 T50 补测试 |');
    expect(renderCoverage(threats, inventory(), [])).toBe(
      renderCoverage(threats, inventory(), [
        { id: 'policy-manual', status: 'skipped', platforms: ['macos'] },
      ]),
    );
  });
});
