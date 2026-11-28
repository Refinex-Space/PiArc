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
    expect(view.hooks).toEqual([]);
    expect(() => parseDiagnostics('[]')).toThrow('Invalid configuration diagnostics');
  });

  it('lists the hooks PiArc does not run', () => {
    const view = parseDiagnostics(
      JSON.stringify({
        workspaces: ['/w'],
        workspace: '/w',
        trusted: true,
        files: [],
        hooks: [
          {
            layer: 'claudeProject',
            file: '/w/.claude/settings.json',
            pointer: '/hooks/PreToolUse/0/hooks/0/async',
            kind: 'unsupportedField',
            message: 'async hooks are not supported; this hook does not run',
          },
          {
            layer: 'user',
            pointer: '/hooks/SubagentStop',
            message: 'SubagentStop hooks are not run yet (T38)',
          },
          { pointer: '/x' },
        ],
      }),
    );
    expect(view.hooks).toEqual([
      {
        layer: 'claudeProject',
        file: '/w/.claude/settings.json',
        pointer: '/hooks/PreToolUse/0/hooks/0/async',
        message: 'async hooks are not supported; this hook does not run',
      },
      {
        layer: 'user',
        file: undefined,
        pointer: '/hooks/SubagentStop',
        message: 'SubagentStop hooks are not run yet (T38)',
      },
    ]);
  });
  it('lists the MCP servers PiArc cannot use and the entries it left out', () => {
    const view = parseDiagnostics(
      JSON.stringify({
        workspaces: ['/w'],
        workspace: '/w',
        trusted: true,
        files: [],
        mcp: {
          unsupported: [
            {
              name: 'events',
              scope: 'project',
              source: '/w/.mcp.json',
              transport: 'sse',
              reason: 'SSE servers are not supported; use streamable HTTP',
            },
            { name: 'broken' },
          ],
          issues: [
            { source: '/w/.mcp.json', pointer: '/mcpServers/bad name', message: 'invalid name' },
            { pointer: '/x' },
          ],
        },
      }),
    );
    expect(view.mcp).toEqual([
      {
        name: 'events',
        source: '/w/.mcp.json',
        transport: 'sse',
        message: 'SSE servers are not supported; use streamable HTTP',
      },
      { source: '/w/.mcp.json', pointer: '/mcpServers/bad name', message: 'invalid name' },
    ]);
  });
});
