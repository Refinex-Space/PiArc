import { expect, it } from 'vitest';
import { moveRailSection, railOrder } from './rail-order.js';

it('keeps unavailable sections in their slots and merges newly registered sections', () => {
  const registered = ['environment', 'tasks', 'context', 'usage'];
  const visible = ['environment', 'context', 'usage'];
  const next = moveRailSection(registered, visible, 'usage', 'environment');
  expect(next).toEqual(['usage', 'tasks', 'environment', 'context']);
  expect(railOrder(['environment', 'tasks', 'usage', 'changes'], next)).toEqual([
    'usage',
    'tasks',
    'environment',
    'changes',
  ]);
  expect(moveRailSection(next, visible, 'missing', 'context')).toBe(next);
});
