import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));

const { sandboxChange } = await import('./sandbox-ipc.js');

describe('sandboxChange', () => {
  it('keeps the known fields of their types (T39)', () => {
    expect(
      sandboxChange({
        enabled: true,
        autoAllow: false,
        allowedDomains: ['a.example'],
        denyRead: [],
      }),
    ).toEqual({ enabled: true, autoAllow: false, allowedDomains: ['a.example'], denyRead: [] });
  });

  it('refuses unknown fields, wrong types and multi-line entries', () => {
    expect(() => sandboxChange({ excludedCommands: [] })).toThrow('unknown sandbox setting');
    expect(() => sandboxChange({ enabled: 'yes' })).toThrow('enabled must be a boolean');
    expect(() => sandboxChange({ allowedDomains: ['a\nb'] })).toThrow('one-line');
    expect(() => sandboxChange({ denyRead: 'x' })).toThrow('list');
  });
});
