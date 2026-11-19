import { describe, expect, it } from 'vitest';

import { parseDiagnostics } from './ConfigDiagnosticsPage.js';

describe('configuration diagnostics', () => {
  it('narrows Core’s report and drops malformed entries', () => {
    const view = parseDiagnostics(
      JSON.stringify({
        workspaces: ['/w', 3],
        workspace: '/w',
        trusted: false,
        files: [
          {
            layer: 'claudeProject',
            file: '/w/.claude/settings.json',
            precedence: 30,
            writable: false,
            status: 'untrusted',
            effective: [
              { pointer: '/permissions/deny', value: ['Bash(rm *)'], finalValue: ['Bash(rm *)'] },
              { value: 1 },
            ],
            overridden: [
              {
                pointer: '/permissions/defaultMode',
                value: 'plan',
                finalValue: 'default',
                source: 'claudeProjectLocal',
              },
            ],
            ignored: [
              { pointer: '/hooks', reason: 'planned', task: 'T25' },
              { pointer: '/x', reason: 'bogus' },
            ],
            issues: [{ message: 'not valid JSON', pointer: '', line: 3, column: 25 }],
          },
          { layer: 'project', file: '/w/.piarc/settings.json', status: 'weird' },
        ],
      }),
    );
    expect(view.workspaces).toEqual(['/w']);
    expect(view.trusted).toBe(false);
    expect(view.files).toHaveLength(1);
    const [file] = view.files;
    expect(file?.status).toBe('untrusted');
    expect(file?.merged).toBe(true);
    expect(file?.effective).toEqual([
      { pointer: '/permissions/deny', value: ['Bash(rm *)'], finalValue: ['Bash(rm *)'] },
    ]);
    expect(file?.overridden[0]?.source).toBe('claudeProjectLocal');
    expect(file?.ignored).toEqual([{ pointer: '/hooks', reason: 'planned', task: 'T25' }]);
    expect(file?.issues).toEqual([{ message: 'not valid JSON', pointer: '', line: 3, column: 25 }]);
    expect(() => parseDiagnostics('[]')).toThrow('Invalid configuration diagnostics');
  });
});
