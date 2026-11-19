// Builds piarc-mock-provider once before the tests. `startMock` (agent-host.ts) runs it with
// `cargo run`; built inside a test instead, it used up the 60 s timeout of the first test that
// needs the mock on CI's Windows runner (r2-workflow, CI runs 44522160246 and 44533872761).
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

export default function globalSetup(): void {
  // The same package, binary and flags as `startMock`, so its `cargo run` finds it built.
  const built = spawnSync(
    'cargo',
    ['build', '-q', '--locked', '-p', 'piarc-testkit', '--bin', 'piarc-mock-provider'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (built.status !== 0) {
    throw new Error(
      `building piarc-mock-provider failed: ${built.error?.message ?? `exit ${String(built.status)}`}`,
    );
  }
}
