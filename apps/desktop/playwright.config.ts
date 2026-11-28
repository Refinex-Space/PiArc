// L4 tests (docs/engineering/testing.md, L4). Two projects drive the same tests against the
// two forms of the app: `dev` runs the Electron binary from node_modules on the production
// bundle in .vite/, `packaged` runs the development-flavor package in out/development/.
// Both need `npm run package:desktop -- --flavor development` first.
//
// Screenshots, app logs and failure traces go to tmp/evidence/<task>/l4/ (not committed);
// set PIARC_EVIDENCE_TASK to the task id, for example T03.
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const evidenceTask = process.env.PIARC_EVIDENCE_TASK ?? 'L4';
const evidenceDir = path.join(import.meta.dirname, '..', '..', 'tmp', 'evidence', evidenceTask);

export default defineConfig<{ appForm: 'dev' | 'packaged' }>({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // Builds the mock provider the tests start, so no test pays for that build.
  globalSetup: './e2e/global-setup.ts',
  outputDir: path.join(evidenceDir, 'l4'),
  // One app at a time: tests launch real windows and the single-instance test owns the lock.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    // agent-host.e2e.ts and agent-host-kill.e2e.ts need Resources/agent-host/, which only the
    // packaged app has;
    // notification.e2e.ts is about PiArc's own (ad-hoc) signature, not Electron's.
    {
      name: 'dev',
      use: { appForm: 'dev' },
      testIgnore: ['agent-host.e2e.ts', 'agent-host-kill.e2e.ts', 'notification.e2e.ts'],
    },
    { name: 'packaged', use: { appForm: 'packaged' } },
  ],
});
