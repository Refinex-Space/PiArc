import { defineConfig } from '@playwright/test';
import type { WorkerFixtures } from './fixtures.js';
import config from './t19.bench.config.js';

export default defineConfig<WorkerFixtures>({ ...config, testMatch: 't44-transcript.bench.ts' });
