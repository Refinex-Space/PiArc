import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));

const { auditQuery, ruleChange } = await import('./permissions-ipc.js');

describe('permission page commands', () => {
  const workspace = process.platform === 'win32' ? 'C:\\work' : '/work';

  it('accepts rule changes for writable files only', () => {
    expect(
      ruleChange({ workspace, layer: 'projectLocal', behavior: 'allow', rule: 'Bash(npm *)' }),
    ).toEqual({ workspace, layer: 'projectLocal', behavior: 'allow', rule: 'Bash(npm *)' });
    expect(ruleChange({ workspace, layer: 'user', behavior: 'deny', old: 'Read(.env)' })).toEqual({
      workspace,
      layer: 'user',
      behavior: 'deny',
      old: 'Read(.env)',
    });
    for (const bad of [
      { workspace, layer: 'claudeProject', behavior: 'allow', rule: 'x' },
      { workspace, layer: 'enterprise', behavior: 'deny', rule: 'x' },
      { workspace: 'relative', layer: 'user', behavior: 'allow', rule: 'x' },
      { workspace, layer: 'user', behavior: 'never', rule: 'x' },
      { workspace, layer: 'user', behavior: 'allow' },
      { workspace, layer: 'user', behavior: 'allow', rule: 'Bash(a)\nBash(b)' },
      { workspace, layer: 'user', behavior: 'allow', rule: ' ' },
      'Bash(x)',
    ]) {
      expect(() => ruleChange(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('bounds audit queries', () => {
    expect(auditQuery({})).toEqual({ limit: 200 });
    expect(
      auditQuery({ sessionId: 's', tool: 'Bash', conclusion: 'deny', since: 5, limit: 10 }),
    ).toEqual({ sessionId: 's', tool: 'Bash', conclusion: 'deny', since: 5, limit: 10 });
    for (const bad of [{ conclusion: 'maybe' }, { limit: 5000 }, { since: -1 }, { tool: '' }, []]) {
      expect(() => auditQuery(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});
