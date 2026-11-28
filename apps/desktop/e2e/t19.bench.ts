// T19's standalone acceptance checks every chapter 11 transcript budget on this run.
import { expect } from '@playwright/test';

import { summarize } from '../../../scripts/bench/s1-transcript.mjs';
import { measureTranscript, test } from './transcript-measurement.js';

test('real Core transcript budgets', async ({ app, page, userDataDir, mock }, info) => {
  const result = await measureTranscript({ app, page, userDataDir, mock }, info);
  expect(result.streaming.longTasksMs).toEqual([]);
  expect(result.streaming.frameWorkMs.p99).toBeLessThanOrEqual(12);
  // 59.997 Hz and 60.0 Hz both describe nominal 60 Hz displays.
  expect(Math.round(result.scrolling.fps)).toBeGreaterThanOrEqual(60);
  expect(summarize(result.coldMs).max).toBeLessThanOrEqual(170);
  expect(summarize(result.cachedMs).max).toBeLessThanOrEqual(100);
});
