// Ported from ego-browser package/ego-browser/src/driver/scroll-motion.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest.

import { expect, test } from 'vitest';

import { dispatchWheelMotion, type WheelEventParams } from './scroll-motion.js';

function recorder() {
  const events: WheelEventParams[] = [];
  const sleeps: number[] = [];
  return {
    events,
    sleeps,
    services: {
      dispatch(event: WheelEventParams) {
        events.push(event);
        return Promise.resolve();
      },
      sleep(ms: number) {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);

test('dispatchWheelMotion preserves the requested delta within one bounded motion', async () => {
  const { events, sleeps, services } = recorder();

  await dispatchWheelMotion(services, { x: 40, y: 80, deltaX: -150, deltaY: 600, modifiers: 2 });

  expect(events.length).toBeGreaterThan(1);
  expect(events.length).toBeLessThanOrEqual(12);
  expect(total(events.map((event) => event.deltaX))).toBe(-150);
  expect(total(events.map((event) => event.deltaY))).toBe(600);
  expect(events.every((event) => event.x === 40 && event.y === 80)).toBe(true);
  expect(events.every((event) => event.modifiers === 2)).toBe(true);
  expect(total(sleeps)).toBeLessThanOrEqual(88);
});

test('dispatchWheelMotion paces a page-sized scroll without visible jumps', async () => {
  const { events, sleeps, services } = recorder();

  await dispatchWheelMotion(services, { x: 400, y: 300, deltaX: 0, deltaY: 960 });

  expect(events.length).toBeGreaterThanOrEqual(10);
  expect(events.length).toBeLessThanOrEqual(12);
  expect(
    events.every((event) => event.deltaY > 0 && event.deltaY <= 960 * 0.18),
    'a single wheel event must not carry a visibly large part of the motion',
  ).toBe(true);
  const duration = total(sleeps);
  expect(duration).toBeGreaterThanOrEqual(80);
  expect(duration).toBeLessThanOrEqual(100);
});

test('dispatchWheelMotion keeps small wheel actions immediate', async () => {
  const { events, sleeps, services } = recorder();

  await dispatchWheelMotion(services, { x: 0, y: 0, deltaX: 0, deltaY: 100 });

  expect(events).toHaveLength(1);
  expect(events[0]?.deltaY).toBe(100);
  expect(sleeps).toEqual([]);
});

test('dispatchWheelMotion stops before the next event once the budget is exhausted', async () => {
  const events: WheelEventParams[] = [];
  let dispatched = 0;

  const completed = await dispatchWheelMotion(
    {
      dispatch(event) {
        events.push(event);
        dispatched += 1;
        return Promise.resolve();
      },
      sleep: () => Promise.resolve(),
      exhausted: () => dispatched >= 2,
    },
    { x: 0, y: 0, deltaX: 0, deltaY: 960 },
  );

  expect(completed).toBe(false);
  expect(events).toHaveLength(2);
  expect(
    total(events.map((event) => event.deltaY)),
    'a cut motion does not flush the remaining delta',
  ).toBeLessThan(960);

  expect(
    await dispatchWheelMotion(
      {
        dispatch: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
        exhausted: () => true,
      },
      { x: 0, y: 0, deltaX: 0, deltaY: 100 },
    ),
    'a single-event motion still dispatches its one event',
  ).toBe(true);
});
