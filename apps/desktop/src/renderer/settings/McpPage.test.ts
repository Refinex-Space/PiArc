import { describe, expect, it } from 'vitest';

import { parseStatus } from './McpPage.js';

describe('MCP settings page', () => {
  it('narrows Core’s status and drops malformed entries', () => {
    const status = parseStatus({
      workspace: '/w',
      servers: [
        {
          name: 'docs',
          scope: 'project',
          source: '/w/.mcp.json',
          transport: 'stdio',
          state: 'connected',
          tools: 3,
          sessions: 2,
          pid: 42,
        },
        {
          name: 'remote',
          scope: 'user',
          source: '/d/settings.json',
          transport: 'http',
          state: 'needsAuth',
          tools: 0,
          sessions: 0,
          error: 'sign in to use it',
          oauth: true,
        },
        { name: 'odd', scope: 'project', source: '/w/.mcp.json', transport: 'stdio', state: 'x' },
        { scope: 'project' },
      ],
      overridden: [{ name: 'docs', source: '/u/.claude.json', by: '/w/.mcp.json' }, { name: 1 }],
      issues: [{ source: '/w/.mcp.json', pointer: '/mcpServers/a b', message: 'invalid name' }],
    });
    expect(status?.servers.map((s) => [s.name, s.state, s.tools, s.sessions])).toEqual([
      ['docs', 'connected', 3, 2],
      ['remote', 'needsAuth', 0, 0],
    ]);
    expect(status?.servers[1]).toMatchObject({ error: 'sign in to use it', oauth: true });
    expect(status?.overridden).toEqual([
      { name: 'docs', source: '/u/.claude.json', by: '/w/.mcp.json' },
    ]);
    expect(status?.issues).toHaveLength(1);
    expect(parseStatus({ servers: 'none' })).toBeUndefined();
    expect(parseStatus(null)).toBeUndefined();
  });
});
