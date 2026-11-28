// Entry point of the Agent Host process (architecture section 5.2). The host itself (stdio,
// Pi's agent directory, signals) is start.ts.
//
// Usage: node agent-host.mjs --data-dir <PiArc data dir> [--bridge-timeout-ms <ms>]
//          [--tool-profile <json file>] [--pi-native-tools] [--test-oauth-provider <json file>]
//          [--test-record-events <dir>] [--test-drop-seq <n>]
//
// `--tool-profile` overrides names and descriptions of the default Tool Profile (tests of the
// name map); `--pi-native-tools` gives sessions Pi's own tools with local I/O (the behavior
// comparison test); `--test-oauth-provider` registers an OAuth provider backed by a local test
// token endpoint (the credential tests); `--test-record-events` writes every raw Pi session
// event to `<dir>/<sessionId>.jsonl` (recording the projection's golden inputs);
// `--test-drop-seq` leaves the session notification with that `seq` out of stdout while keeping
// it for replay (the gap backfill test). Core passes none of them.
//
// stdout carries AHP frames only. Anything else that writes to it (a library's console.log)
// is redirected to stderr, which is the log channel Core reads line by line.
//
// Pi is loaded dynamically, after `runtime/env-proxy.js`: that module records the proxy-aware
// `fetch` dispatcher Node installs at start, which loading Pi replaces (ADR-0082).
import { restoreEnvProxy } from './runtime/env-proxy.js';

const { start } = await import('./start.js');
if (restoreEnvProxy()) {
  process.stderr.write('restored the proxy dispatcher of fetch after loading Pi\n');
}
start();
