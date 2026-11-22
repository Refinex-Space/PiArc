// T45-A09: a fresh profile through a whole mock session (a workspace, a session and its turn, the
// settings window) makes no outbound connection from Electron: Chromium's net log (main and
// renderer requests and Chromium's own background requests) and the main process's Node-level
// connections hold nothing but loopback (a control request to the mock provider proves the log
// captures requests; the app's own `app://` pages never reach the network stack). The Agent Host's side is
// crates/piarc-testkit/tests/egress.rs; the report is docs/security/egress.md.
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, prefer } from './t19.js';

const NETLOG = path.join(os.tmpdir(), `piarc-t45-netlog-${String(process.pid)}.json`);

/**
 * Chromium's spellchecker downloads Hunspell dictionaries on Windows and Linux (macOS uses the
 * system's): listed in docs/security/egress.md, it carries only a language code.
 */
const ALLOWED_HOSTS = process.platform === 'win32' ? [/(^|\.)gvt1\.com$/u] : [];

test.use({ appArgs: [`--log-net-log=${NETLOG}`] });

/** Remote endpoints of Chromium's IPv6 and IPv4 reachability probes (a UDP connect, no data). */
const REACHABILITY_PROBES = ['[2001:4860:4860::8888]:443', '8.8.8.8:443'];

/**
 * The remote targets in a net log: request URLs, resolved host names and the addresses sockets
 * connect to (not their local addresses). A UDP socket that only connected to a reachability
 * probe address and sent nothing is Chromium testing for a route, not a connection. The file
 * may end mid-array when the app was killed: events are read line by line.
 */
export function netLogTargets(text: string): string[] {
  const start = text.indexOf('"events"');
  if (start < 0) return [];
  const constants = JSON.parse(text.slice(0, start).trim().replace(/,$/u, '') + '}') as {
    constants: { logEventTypes: Record<string, number> };
  };
  const type = new Map(Object.entries(constants.constants.logEventTypes).map(([k, v]) => [v, k]));
  const events = text
    .slice(text.indexOf('[', start) + 1)
    .split('\n')
    .map((line) => line.trim().replace(/,$/u, ''))
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NetLogEvent];
      } catch {
        return [];
      }
    });
  const sent = new Set(
    events.filter((e) => type.get(e.type) === 'UDP_BYTES_SENT').map((e) => e.source.id),
  );
  const found = new Set<string>();
  for (const event of events) {
    const name = type.get(event.type) ?? '';
    const params = event.params ?? {};
    if (name === 'URL_REQUEST_START_JOB' && typeof params.url === 'string') found.add(params.url);
    if (name.startsWith('HOST_RESOLVER') && typeof params.host === 'string') found.add(params.host);
    const connect = ['TCP_CONNECT_ATTEMPT', 'UDP_CONNECT', 'SOCKET_CONNECT', 'TCP_CONNECT'];
    if (connect.includes(name) && typeof params.address === 'string') {
      const probe = REACHABILITY_PROBES.includes(params.address) && !sent.has(event.source.id);
      if (!probe) found.add(params.address);
    }
  }
  return [...found];
}

interface NetLogEvent {
  readonly type: number;
  readonly source: { readonly id: number };
  readonly params?: { readonly url?: unknown; readonly host?: unknown; readonly address?: unknown };
}

/** Whether a target leaves the machine: not the app's scheme, not loopback, not inline data. */
export function external(target: string): boolean {
  if (/^(app:|data:|blob:|about:|chrome:|devtools:|chrome-extension:)/u.test(target)) return false;
  const host = (() => {
    try {
      return new URL(target).hostname;
    } catch {
      return target.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '');
    }
  })();
  if (host === '' || /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/u.test(host)) {
    return false;
  }
  return !ALLOWED_HOSTS.some((allowed) => allowed.test(host));
}

test('THR-04 a whole mock session makes no outbound connection from Electron', async ({
  app,
  page,
  workspaces,
  mock,
}) => {
  test.setTimeout(120_000);
  // The fixture started the app already; Chromium writes NETLOG from its first request.
  await app.evaluate(() => {
    const dc = process.getBuiltinModule('node:diagnostics_channel');
    const seen: string[] = [];
    (globalThis as { __piarcConnections?: string[] }).__piarcConnections = seen;
    dc.subscribe('net.client.socket', (message) => {
      const { socket } = message as {
        socket: {
          once(e: string, f: () => void): void;
          remoteAddress?: string;
          remotePort?: number;
        };
      };
      socket.once('connect', () =>
        seen.push(`${String(socket.remoteAddress)}:${String(socket.remotePort)}`),
      );
    });
    dc.subscribe('undici:client:connected', (message) => {
      const { connectParams } = message as { connectParams: { hostname: string; port: string } };
      seen.push(`${connectParams.hostname}:${connectParams.port}`);
    });
  });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'egress 外连');
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat');
  await focusMain(app);
  await idle(page);
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  for (const nav of ['providers', 'mcp', 'skills', 'diagnostics']) {
    await settings.getByTestId(`settings-nav-${nav}`).click();
  }

  // The control: one loopback request through Chromium's network stack must show in the log
  // (the app's own pages are served in-process and leave nothing there).
  const control = `${mock.baseUrl}/_piarc/requests`;
  await app.evaluate(({ net }, url) => net.fetch(url).then((r) => r.status), control);

  const mainProcess = await app.evaluate(
    () => (globalThis as { __piarcConnections?: string[] }).__piarcConnections ?? [],
  );
  expect(mainProcess.filter(external)).toEqual([]);
  await app.close();
  const targets = netLogTargets(await readFile(NETLOG, 'utf8'));
  expect(targets, 'the net log recorded the control request').toContain(control);
  expect(targets.filter(external)).toEqual([]);
  console.log(
    `THR-04: net log targets ${String(targets.length)} (none external); main-process connections ${String(mainProcess.length)}`,
  );
  await rm(NETLOG, { force: true });
});
