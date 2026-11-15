// Starts the piarc-mock-provider binary (crates/piarc-testkit) for tests and reads its
// request log. The binary is built with cargo on first use, so the tests always run the
// mock from the current source.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/testkit/src/mock-provider.ts). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** One entry of the mock's request log (`GET /_piarc/requests`). */
export interface RequestRecord {
  seq: number;
  path: string;
  format: string | null;
  scenario: string | null;
  stepIndex: number | null;
  headers: Record<string, string>;
  body: string;
  violations: { rule: string; message: string }[];
  outcome: string;
}

export interface MockProviderProcess {
  port: number;
  /** Base URL for Anthropic Messages clients. */
  anthropicBaseUrl: string;
  /** Base URL for OpenAI-compatible clients. */
  openaiBaseUrl: string;
  records: () => Promise<RequestRecord[]>;
  /** Closes stdin and resolves with the exit code once the process ends. */
  stop: () => Promise<number | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds the binary with cargo and returns the path of the executable. */
export async function buildMockProvider(): Promise<string> {
  const args = [
    'build',
    '--locked',
    '--package',
    'piarc-testkit',
    '--bin',
    'piarc-mock-provider',
    '--message-format',
    'json',
  ];
  const child = spawn('cargo', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  let executable: string | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    const message: unknown = JSON.parse(line);
    if (
      isRecord(message) &&
      message.reason === 'compiler-artifact' &&
      typeof message.executable === 'string'
    ) {
      executable = message.executable;
    }
  }
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (code !== 0 || executable === undefined) {
    throw new Error(`cargo build of piarc-mock-provider failed (exit code ${String(code)})`);
  }
  return executable;
}

/** Starts the binary on a free port with the given scenario files or directories. */
export async function startMockProvider(
  executable: string,
  scenarioPaths: string[],
): Promise<MockProviderProcess> {
  const args = ['--port', '0', ...scenarioPaths.flatMap((path) => ['--scenarios', path])];
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const lines = createInterface({ input: child.stdout });
  const firstLine = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-provider exited with ${String(code)} before printing its port`));
    });
  });
  lines.close();
  const port = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`expected a port on the first stdout line, got ${JSON.stringify(firstLine)}`);
  }
  const origin = `http://127.0.0.1:${String(port)}`;
  return {
    port,
    anthropicBaseUrl: origin,
    openaiBaseUrl: `${origin}/v1`,
    records: async () => parseRecords(await (await fetch(`${origin}/_piarc/requests`)).json()),
    stop: async () => {
      child.stdin.end();
      return exited;
    },
  };
}

function parseRecords(value: unknown): RequestRecord[] {
  if (!Array.isArray(value)) {
    throw new TypeError('the request log is not a JSON array');
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new TypeError('a request record is not an object');
    }
    const { seq, path, format, scenario, step_index, headers, body, violations, outcome } = entry;
    if (
      typeof seq !== 'number' ||
      typeof path !== 'string' ||
      typeof body !== 'string' ||
      typeof outcome !== 'string' ||
      !isRecord(headers) ||
      !Array.isArray(violations)
    ) {
      throw new TypeError(`malformed request record: ${JSON.stringify(entry)}`);
    }
    return {
      seq,
      path,
      format: typeof format === 'string' ? format : null,
      scenario: typeof scenario === 'string' ? scenario : null,
      stepIndex: typeof step_index === 'number' ? step_index : null,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, header]) => [name, String(header)]),
      ),
      body,
      violations: violations.map((violation: unknown) => ({
        rule: isRecord(violation) ? String(violation.rule) : '',
        message: isRecord(violation) ? String(violation.message) : '',
      })),
      outcome,
    };
  });
}
