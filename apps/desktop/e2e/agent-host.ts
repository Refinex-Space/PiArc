// Helpers for the L4 tests of the packaged app's Agent Host (agent-host.e2e.ts,
// agent-host-kill.e2e.ts).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

export interface MockProcess {
  baseUrl: string;
  stop: () => void;
}

/** Starts piarc-mock-provider (built by cargo on first use) with one scenario file. */
export async function startMock(scenario: string): Promise<MockProcess> {
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
      '-p',
      'piarc-testkit',
      '--bin',
      'piarc-mock-provider',
      '--',
      '--port',
      '0',
      '--scenarios',
      scenario,
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-provider exited with ${String(code)}`));
    });
  });
  lines.close();
  return {
    baseUrl: `http://127.0.0.1:${first.trim()}`,
    stop: () => child.stdin.end(),
  };
}
