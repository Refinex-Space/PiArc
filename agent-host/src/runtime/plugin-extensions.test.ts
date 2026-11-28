import { describe, expect, it } from 'vitest';

import { parseExtensions, pluginExtensions, sameExtensions } from './plugin-extensions.js';

describe('package Pi extensions', () => {
  it('takes the entries Core answers and loads none on any failure', async () => {
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    const ok = {
      request: () => Promise.resolve({ extensions: [{ package: 'p', path: '/x/ext.ts' }] }),
    };
    expect(await pluginExtensions(ok, '/w', log)).toEqual(['/x/ext.ts']);
    const broken = { request: () => Promise.resolve({ extensions: [{ package: 'p' }] }) };
    expect(await pluginExtensions(broken, '/w', log)).toEqual([]);
    const failing = { request: () => Promise.reject(new Error('down')) };
    expect(await pluginExtensions(failing, '/w', log)).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(parseExtensions({})).toBeUndefined();
    expect(sameExtensions(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameExtensions(['a'], ['b'])).toBe(false);
  });
});
