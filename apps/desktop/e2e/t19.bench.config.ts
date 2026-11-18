import path from 'node:path';
import { defineConfig } from '@playwright/test';

import type { WorkerFixtures } from './fixtures.js';

// Performance needs a foreground window on an idle desktop. Run explicitly with npm run bench:t19.
export default defineConfig<WorkerFixtures>({
  testDir: '.',
  testMatch: 't19.bench.ts',
  outputDir: path.resolve(import.meta.dirname, '../../../tmp/evidence/T19/bench'),
  workers: 1,
  timeout: 180_000,
  reporter: 'list',
  use: { appForm: 'packaged', trace: 'off' },
});
