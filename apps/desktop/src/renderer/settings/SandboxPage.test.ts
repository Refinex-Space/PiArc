import { describe, expect, it } from 'vitest';

import { parseSandboxView } from './SandboxPage.js';

describe('parseSandboxView', () => {
  it('reads the sources of each entry and the platform (T39)', () => {
    const view = parseSandboxView(
      JSON.stringify({
        workspaces: ['/w'],
        workspace: '/w',
        platform: { supported: true, available: false },
        enabled: true,
        autoAllow: false,
        user: {
          enabled: true,
          autoAllow: null,
          allowedDomains: ['a.example'],
          denyRead: ['~/.ssh'],
        },
        allowedDomains: [
          { value: 'a.example', origin: 'user', layer: 'user', editable: true },
          { value: 'corp.example', origin: 'enterprise', layer: 'enterprise', editable: false },
          { value: 'bad', origin: 'elsewhere', editable: false },
        ],
        denyRead: [{ value: '/h/.ssh', origin: 'user', layer: 'user', editable: true }],
        writable: [{ kind: 'workspace', path: '/w' }],
        ignored: [
          {
            layer: 'project',
            file: '/w/.piarc/settings.json',
            pointer: '/sandbox/network/allowedDomains',
            reason: 'projectSandbox',
          },
        ],
      }),
    );
    expect(view.available).toBe(false);
    expect(view.allowedDomains.map((e) => [e.value, e.origin, e.editable])).toEqual([
      ['a.example', 'user', true],
      ['corp.example', 'enterprise', false],
    ]);
    expect(view.userDenyRead).toEqual(['~/.ssh']);
    expect(view.ignored[0]?.reason).toBe('projectSandbox');
  });

  it('refuses an answer without its platform', () => {
    expect(() => parseSandboxView('{"user":{}}')).toThrow('Invalid sandbox settings');
  });
});
