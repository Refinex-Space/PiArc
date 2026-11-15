// Entry point of the Agent Host process (architecture section 5.2): takes over stdio, pins
// Pi's process-global agent directory to PiArc's, runs the host and handles signals.
//
// Usage: node agent-host.mjs --data-dir <PiArc data dir> [--bridge-timeout-ms <ms>]
//          [--tool-profile <json file>] [--pi-native-tools]
//
// `--tool-profile` overrides names and descriptions of the default Tool Profile (tests of the
// name map); `--pi-native-tools` gives sessions Pi's own tools with local I/O (the behavior
// comparison test). Core passes neither.
//
// stdout carries AHP frames only. Anything else that writes to it (a library's console.log)
// is redirected to stderr, which is the log channel Core reads line by line.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { VERSION } from '@earendil-works/pi-coding-agent';

import { runHost } from './host.js';
import { agentDirOf } from './runtime/workspace.js';
import { profileWithOverrides, type ToolProfile } from './tools/index.js';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'bridge-timeout-ms': { type: 'string' },
    'tool-profile': { type: 'string' },
    'pi-native-tools': { type: 'boolean' },
  },
  strict: true,
});
const dataDir = values['data-dir'];
if (dataDir === undefined || dataDir.length === 0) {
  process.stderr.write('usage: agent-host --data-dir <dir> [--bridge-timeout-ms <ms>]\n');
  process.exit(64);
}
const profileFile = values['tool-profile'];
let toolProfile: ToolProfile | undefined;
if (profileFile !== undefined) {
  try {
    toolProfile = profileWithOverrides(JSON.parse(readFileSync(profileFile, 'utf8')));
  } catch (error) {
    process.stderr.write(`invalid --tool-profile ${profileFile}: ${String(error)}\n`);
    process.exit(64);
  }
}
const bridgeTimeout = values['bridge-timeout-ms'];
const bridgeTimeoutMs =
  bridgeTimeout === undefined ? undefined : Number.parseInt(bridgeTimeout, 10);

// Pi's MCP extension and a few defaults read the agent directory from this variable rather
// than from the SDK's `agentDir` option (docs/research/pi-v1.4.0-baseline.md, "版本差异").
process.env.PI_CODING_AGENT_DIR = agentDirOf(dataDir);

const stdout = process.stdout;
const protocolWrite = stdout.write.bind(stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
stdout.write = stderrWrite;

const log = (line: string): void => {
  stderrWrite(`${line}\n`);
};
const exit = (code: number): void => {
  // Let stderr drain first: on macOS a pipe write is asynchronous.
  stderrWrite('', () => process.exit(code));
};

const host = runHost(
  process.stdin,
  {
    write: (chunk) => protocolWrite(chunk),
    once: (event, listener) => stdout.once(event, listener),
  },
  {
    dataDir,
    piVersion: VERSION,
    ...(bridgeTimeoutMs === undefined || Number.isNaN(bridgeTimeoutMs) ? {} : { bridgeTimeoutMs }),
    ...(toolProfile === undefined ? {} : { toolProfile }),
    ...(values['pi-native-tools'] === true ? { piNativeTools: true } : {}),
    log,
    exit,
  },
);

let signalled = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (signalled) {
      process.exit(128 + (signal === 'SIGTERM' ? 15 : 2));
    }
    signalled = true;
    void host.shutdown(signal, 0);
  });
}
