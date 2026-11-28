// The Agent Host proper, started by main.ts once Pi is loaded: takes over stdio, pins Pi's
// process-global agent directory to PiArc's, runs the host and handles signals. The usage and
// options are described in main.ts.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { VERSION } from '@earendil-works/pi-coding-agent';

import { runHost } from './host.js';
import {
  parseTestOAuthProvider,
  type TestOAuthProviderConfig,
} from './runtime/test-oauth-provider.js';
import { agentDirOf } from './runtime/workspace.js';
import { profileWithOverrides, type ToolProfile } from './tools/index.js';

/** Parses the arguments and runs the host on stdio until it exits. */
export function start(): void {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'bridge-timeout-ms': { type: 'string' },
      'tool-profile': { type: 'string' },
      'pi-native-tools': { type: 'boolean' },
      'test-oauth-provider': { type: 'string' },
      'test-record-events': { type: 'string' },
      'test-drop-seq': { type: 'string' },
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
  const oauthFile = values['test-oauth-provider'];
  let testOAuthProvider: TestOAuthProviderConfig | undefined;
  if (oauthFile !== undefined) {
    let parsed: TestOAuthProviderConfig | string;
    try {
      parsed = parseTestOAuthProvider(JSON.parse(readFileSync(oauthFile, 'utf8')));
    } catch (error) {
      parsed = String(error);
    }
    if (typeof parsed === 'string') {
      process.stderr.write(`invalid --test-oauth-provider ${oauthFile}: ${parsed}\n`);
      process.exit(64);
    }
    testOAuthProvider = parsed;
  }
  const recordDir = values['test-record-events'];
  const recordEvents =
    recordDir === undefined
      ? undefined
      : (sessionId: string, event: unknown): void => {
          mkdirSync(recordDir, { recursive: true });
          appendFileSync(path.join(recordDir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
        };
  const dropSeqText = values['test-drop-seq'];
  const dropSeq = dropSeqText === undefined ? undefined : Number.parseInt(dropSeqText, 10);
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
      ...(bridgeTimeoutMs === undefined || Number.isNaN(bridgeTimeoutMs)
        ? {}
        : { bridgeTimeoutMs }),
      ...(toolProfile === undefined ? {} : { toolProfile }),
      ...(values['pi-native-tools'] === true ? { piNativeTools: true } : {}),
      ...(testOAuthProvider === undefined ? {} : { testOAuthProvider }),
      ...(recordEvents === undefined ? {} : { recordEvents }),
      ...(dropSeq === undefined || Number.isNaN(dropSeq) ? {} : { dropSeq }),
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
}
