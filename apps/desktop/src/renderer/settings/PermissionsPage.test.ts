import { describe, expect, it } from 'vitest';

import { parseView } from './PermissionsPage.js';

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
