// Times AHP round trips of small `fs/read` requests (T07-A10, architecture section 11). Core's
// supervisor starts this script in place of the Agent Host bundle, so the requests travel the
// real path: JSON frames over the child's stdout and stdin, Core's frame decoder, its inbound
// dispatch and `piarc-fs`. Run by Node directly (type stripping):
//
//   node ahp-fs-read-client.ts --data-dir <dir> --protocol <major.minor> --session <id>
//        --path <file> --count <n> --warmup <n> --report <json file>
//
// After the handshake it sends `--warmup` + `--count` reads one after another, writes the
// timings of the last `--count` to `--report` ({ count, p50, p95, p99, max } in milliseconds,
// plus the samples) and then answers `host/shutdown` and exits when Core closes stdin.
import { renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    protocol: { type: 'string' },
    session: { type: 'string' },
    path: { type: 'string' },
    count: { type: 'string' },
    warmup: { type: 'string' },
    report: { type: 'string' },
  },
  strict: true,
});

function required(name: string, value: string | undefined): string {
  if (value === undefined) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(64);
  }
  return value;
}

const protocol = required('protocol', values.protocol);
const session = required('session', values.session);
const file = required('path', values.path);
const count = Number.parseInt(required('count', values.count), 10);
const warmup = Number.parseInt(required('warmup', values.warmup), 10);
const report = required('report', values.report);

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Responses by id, for the one request in flight. */
let waiting: { id: number; resolve: (message: Record<string, unknown>) => void } | undefined;
let nextId = 1;

function request(method: string, params: object): Promise<Record<string, unknown>> {
  const id = nextId++;
  const response = new Promise<Record<string, unknown>>((resolve) => {
    waiting = { id, resolve };
  });
  send({ jsonrpc: '2.0', id, method, params });
  return response;
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) {
    return;
  }
  if (typeof message.method === 'string' && 'id' in message) {
    // Core's requests: heartbeats and the orderly shutdown.
    if (message.method === 'host/shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: { closedSessions: 0 } });
    } else if (message.method === 'host/ping') {
      const sentAt = isRecord(message.params) ? message.params.sentAt : 0;
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          sentAt,
          rssBytes: process.memoryUsage.rss(),
          outboundQueuedFrames: 0,
          outboundQueuedBytes: 0,
          outboundPeakBytes: 0,
          sessions: 0,
        },
      });
    }
    return;
  }
  if (waiting !== undefined && message.id === waiting.id) {
    const { resolve } = waiting;
    waiting = undefined;
    resolve(message);
  }
});
lines.on('close', () => process.exit(0));

const welcome = await request('host/hello', { protocol, pi: 'bench', capabilities: [] });
if (!('result' in welcome)) {
  process.stderr.write(`handshake refused: ${JSON.stringify(welcome)}\n`);
  process.exit(2);
}

const samples: number[] = [];
for (let i = 0; i < warmup + count; i++) {
  const started = performance.now();
  const response = await request('fs/read', { sessionId: session, path: file });
  const elapsed = performance.now() - started;
  if (!isRecord(response.result) || typeof response.result.text !== 'string') {
    process.stderr.write(`fs/read failed: ${JSON.stringify(response)}\n`);
    process.exit(1);
  }
  if (i >= warmup) {
    samples.push(elapsed);
  }
}
const sorted = [...samples].sort((a, b) => a - b);
const at = (q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
// Written under another name first: the test polls for the report.
writeFileSync(
  `${report}.partial`,
  JSON.stringify({
    count: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
    samples,
  }),
);
renameSync(`${report}.partial`, report);
