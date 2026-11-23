import { describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { startupFailure } from './startup-error.js';

function coreError(data: unknown): Error {
  const error = new Error('the managed settings at /x are not valid: expected value');
  Object.assign(error, { code: -32024, data });
  return error;
}

describe('the startup failure dialog', () => {
  it('names the managed source and the position of the error, in the system language', () => {
    const error = coreError({
      kind: 'managedSettingsInvalid',
      retryable: false,
      details: {
        location: '/Library/Application Support/PiArc/managed-settings.json',
        reason: 'expected `,` or `}`',
        line: 3,
        column: 7,
      },
    });
    const en = startupFailure(error, new Translator('en'));
    expect(en.title).toBe('PiArc could not start');
    expect(en.message).toContain('/Library/Application Support/PiArc/managed-settings.json');
    expect(en.message).toContain('Line 3, column 7');
    expect(en.message).toContain('expected `,` or `}`');
    const zh = startupFailure(error, new Translator('zh-CN'));
    expect(zh.title).toBe('PiArc 无法启动');
    expect(zh.message).toContain('第 3 行，第 7 列');
  });

  it('leaves the position out for a source without one (a plist, a registry value)', () => {
    const error = coreError({
      kind: 'managedSettingsInvalid',
      retryable: false,
      details: { location: 'HKLM\\SOFTWARE\\Policies\\PiArc\\Settings', reason: 'not an object' },
    });
    const { message } = startupFailure(error, new Translator('en'));
    expect(message).toContain('HKLM\\SOFTWARE\\Policies\\PiArc\\Settings');
    expect(message).not.toContain('Line');
  });

  it('says Core failed to load for any other error', () => {
    const { message } = startupFailure(new Error('dlopen failed'), new Translator('en'));
    expect(message).toBe('PiArc Core failed to load.\n\ndlopen failed');
    expect(startupFailure('boom', new Translator('zh-CN')).message).toContain('boom');
  });
});
