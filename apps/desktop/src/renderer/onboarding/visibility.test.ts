import { expect, it } from 'vitest';

import { autoShow } from './visibility.js';

it('opens by itself only for a first run without a workspace or a launch target', () => {
  const base = { completed: false, workspacesKnown: true, workspaces: 0, launched: false };
  expect(autoShow(base)).toBe('show');
  expect(autoShow({ ...base, workspacesKnown: false })).toBe('wait');
  expect(autoShow({ ...base, completed: true })).toBe('hide');
  expect(autoShow({ ...base, completed: true, workspacesKnown: false })).toBe('hide');
  expect(autoShow({ ...base, workspaces: 2 })).toBe('hide');
  expect(autoShow({ ...base, launched: true })).toBe('hide');
  expect(autoShow({ ...base, launched: true, workspacesKnown: false })).toBe('hide');
});
