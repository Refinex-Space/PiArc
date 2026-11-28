import { describe, expect, it } from 'vitest';

import { parseAudit, parseView } from './PermissionsPage.js';

describe('permission view', () => {
  it('keeps the suggested rule for a rule that never matches', () => {
    const view = parseView(
      JSON.stringify({
        workspaces: ['/w'],
        workspace: '/w',
        sources: [
          {
            id: 'claudeProject',
            file: '/w/.claude/settings.json',
            writable: false,
            rules: [
              {
                behavior: 'allow',
                rule: 'Write(src/**)',
                broad: false,
                suggestion: 'Edit(src/**)',
              },
              { behavior: 'deny', rule: 'Bash(rm *)', broad: false },
            ],
          },
        ],
      }),
    );
    const [write, deny] = view.sources[0]?.rules ?? [];
    expect(write?.suggestion).toBe('Edit(src/**)');
    expect(deny && 'suggestion' in deny).toBe(false);
  });

  it('marks the rules that match an argument of the call', () => {
    const view = parseView(
      JSON.stringify({
        workspaces: ['/w'],
        workspace: '/w',
        sources: [
          {
            id: 'piarcUser',
            writable: true,
            rules: [
              { behavior: 'deny', rule: 'Agent(model:opus)', broad: false, parameter: 'model' },
              { behavior: 'deny', rule: 'Agent(Explore)', broad: false },
            ],
          },
        ],
      }),
    );
    const [param, type] = view.sources[0]?.rules ?? [];
    expect(param?.parameter).toBe('model');
    expect(type && 'parameter' in type).toBe(false);
  });
});

describe('package audit rows (ADR-0102)', () => {
  it('names the action, the package and version, where it came from and the result', () => {
    const rows = parseAudit(
      JSON.stringify({
        events: [
          {
            at: 2,
            detail: {
              action: 'install',
              source: 'npm',
              origin: 'market',
              id: 'pi-tools',
              version: '1.2.0',
              scope: 'user',
              result: 'installed',
            },
          },
          {
            at: 1,
            detail: {
              action: 'install',
              source: 'git',
              location: 'https://example.test/x.git',
              scope: 'project',
              result: 'failed: no manifest',
            },
          },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({
      tool: 'install',
      step: 'market',
      rule: 'pi-tools@1.2.0',
      ruleSource: 'user',
      plugin: { ok: true },
    });
    expect(rows[1]).toMatchObject({
      step: 'git',
      rule: 'https://example.test/x.git',
      plugin: { ok: false, result: 'failed: no manifest' },
    });
  });
});
