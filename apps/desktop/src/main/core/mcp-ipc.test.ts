import { describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { addConfirmation, definitionOf, serverInput } from './mcp-ipc.js';

describe('adding an MCP server', () => {
  it('checks the page input and writes the matching definition', () => {
    const stdio = serverInput({
      scope: 'user',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      extra: 'ignored',
    });
    expect(definitionOf(stdio)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    });
    const http = serverInput({
      scope: 'projectLocal',
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(definitionOf(http)).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp' });
    expect(
      definitionOf(
        serverInput({
          scope: 'user',
          name: 'x',
          transport: 'stdio',
          command: 'x',
          args: [],
          env: {},
        }),
      ),
    ).toEqual({ type: 'stdio', command: 'x' });
  });

  it('refuses what Core would not write', () => {
    for (const raw of [
      null,
      { scope: 'project', name: 'a', transport: 'http', url: 'https://a.test' },
      { scope: 'user', name: 'a b', transport: 'http', url: 'https://a.test' },
      { scope: 'user', name: 'a__b', transport: 'http', url: 'https://a.test' },
      { scope: 'user', name: 'a', transport: 'http', url: 'file:///etc/passwd' },
      { scope: 'user', name: 'a', transport: 'sse', url: 'https://a.test' },
      { scope: 'user', name: 'a', transport: 'stdio', command: ' ', args: [], env: {} },
      { scope: 'user', name: 'a', transport: 'stdio', command: 'x', args: [1], env: {} },
      { scope: 'user', name: 'a', transport: 'stdio', command: 'x', args: [], env: { '1A': 'x' } },
      { scope: 'user', name: 'a', transport: 'stdio', command: 'x', args: [], env: { A: 1 } },
    ]) {
      expect(() => serverInput(raw), JSON.stringify(raw)).toThrow(TypeError);
    }
  });

  it('confirms what runs and where it is saved, with variable names but not their values', () => {
    const t = new Translator('en');
    const text = addConfirmation(
      t,
      serverInput({
        scope: 'projectLocal',
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'a b'],
        env: { GITHUB_TOKEN: 'ghp-secret-value' },
      }),
    );
    expect(text.message).toBe('Add the MCP server “github”?');
    expect(text.detail).toContain('.piarc/settings.local.json');
    expect(text.detail).toContain('Runs: npx "-y" "a b"');
    expect(text.detail).toContain('GITHUB_TOKEN');
    expect(text.detail).not.toContain('ghp-secret-value');
  });
});
