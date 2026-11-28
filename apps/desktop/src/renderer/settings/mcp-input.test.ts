import { describe, expect, it } from 'vitest';

import { envFromRows, splitCommand, validServerName, validServerUrl } from './mcp-input.js';

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted words together', () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-github')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    expect(splitCommand(`node "/Users/me/My Server/index.js" --name 'a b' ""`)).toEqual([
      'node',
      '/Users/me/My Server/index.js',
      '--name',
      'a b',
      '',
    ]);
    expect(splitCommand('C:\\\\tools\\\\mcp.exe say\\ hi')).toEqual([
      'C:\\tools\\mcp.exe',
      'say hi',
    ]);
    expect(splitCommand('  ')).toEqual([]);
  });

  it('refuses an unclosed quote', () => {
    expect(splitCommand('node "index.js')).toBeUndefined();
  });
});

describe('envFromRows', () => {
  it('reads the rows, trims them and skips blank ones', () => {
    expect(
      envFromRows([
        { name: ' TOKEN ', value: '${GITHUB_TOKEN}' },
        { name: '', value: '' },
        { name: 'EMPTY', value: '' },
      ]),
    ).toEqual({ TOKEN: '${GITHUB_TOKEN}', EMPTY: '' });
  });

  it('refuses a bad or repeated name and a value without a name', () => {
    expect(envFromRows([{ name: '1A', value: 'x' }])).toBeUndefined();
    expect(envFromRows([{ name: '', value: 'x' }])).toBeUndefined();
    expect(
      envFromRows([
        { name: 'A', value: '1' },
        { name: 'A', value: '2' },
      ]),
    ).toBeUndefined();
  });
});

it('checks names and addresses like Core', () => {
  expect(validServerName('git-hub_2')).toBe(true);
  expect(validServerName('a__b')).toBe(false);
  expect(validServerName('a b')).toBe(false);
  expect(validServerUrl('https://mcp.linear.app/mcp')).toBe(true);
  expect(validServerUrl('file:///etc/passwd')).toBe(false);
});
