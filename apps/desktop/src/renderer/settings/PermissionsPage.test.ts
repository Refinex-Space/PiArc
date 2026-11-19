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
});
