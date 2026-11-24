// T36 with the real Core, Agent Host and mock provider: the settings window's MCP page lists
// each server of the workspace with its source, scope, transport, state and tool count; turning
// a server off and on and reconnecting take effect in the workspace's pool (A12). A server
// defined in the user settings and in the project's `.mcp.json` takes the project's whole
// definition and the replaced one is listed; SSE and WebSocket servers are marked unsupported on
// the MCP page and in Configuration diagnostics (A05). The session's first request carries the
// servers' tools as `mcp__<server>__<tool>` (A01). Screenshots go to tmp/evidence/T36/.
import { openSettings } from './settings-panel.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

import {
  expect,
  focusMain,
  makeWorkspace,
  mockRequests,
  openFolder,
  startSession,
  test as sessions,
} from './sessions.js';
import { idle, prefer } from './t19.js';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const EVIDENCE = path.join(REPO, 'tmp', 'evidence', 'T36');
const ECHO_SERVER = path.join(REPO, 'packages', 'testkit', 'src', 'mcp-echo-server.ts');

/**
 * A stdio echo server run by the Node that runs this test (type stripping). It logs its process
 * id to `<workspace>/mcp-starts.jsonl` when it starts (servers run in the workspace root).
 */
function echo(name: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [ECHO_SERVER, name],
    env: { MCP_ECHO_START_LOG: 'mcp-starts.jsonl', ...env },
  };
}

/** The process ids `name`'s server started with, in order. */
async function starts(workspace: string, name: string): Promise<number[]> {
  const text = await readFile(path.join(workspace, 'mcp-starts.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { server: string; pid: number })
    .filter((entry) => entry.server === name)
    .map((entry) => entry.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const test = sessions.extend({
  // The user's PiArc settings, before the app starts: `notes` is a user server, `echo` is
  // replaced by the project's definition of the same name.
  userDataDir: async ({ userDataDir }, use) => {
    const file = path.join(userDataDir, 'settings.json');
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // No user settings yet.
    }
    await writeFile(
      file,
      JSON.stringify({
        ...current,
        mcpServers: {
          echo: echo('user-echo'),
          notes: echo('notes', { MCP_ECHO_TOOLS: '2' }),
        },
      }),
    );
    await use(userDataDir);
  },
});

const MCP_JSON = JSON.stringify({
  mcpServers: {
    echo: echo('echo'),
    legacy: { type: 'sse', url: 'https://legacy.example/sse' },
    sockets: { type: 'ws', url: 'wss://sockets.example/mcp' },
  },
});

async function openMcp(page: Page): Promise<Page> {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-mcp').click();
  await settings.getByTestId('mcp-page').waitFor();
  return settings;
}

function server(settings: Page, name: string) {
  return settings.locator(`[data-testid="mcp-server"][data-name="${name}"]`);
}

test('the MCP page shows the pool and turns servers off, on and reconnects them', async ({
  app,
  page,
  workspaces,
  userDataDir,
  mock,
}) => {
  test.setTimeout(150_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'mcp 服务', { '.mcp.json': MCP_JSON });
  await openFolder(page, app, ws);
  // Trusting the project lets its `echo` start; the session's first run connects the servers.
  await startSession(page, 'Hello', 't18-chat', 'trust');
  // The turn may not have started yet when the conversation shows: wait for its request.
  await expect
    .poll(async () => (await mockRequests(mock, 't18-chat')).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await idle(page);
  const [first] = await mockRequests(mock, 't18-chat');
  expect(first?.tools).toEqual(
    expect.arrayContaining([
      'mcp__echo__echo',
      'mcp__echo__whoami',
      'mcp__notes__echo',
      'mcp__notes__extra_2',
    ]),
  );
  expect(first?.tools.some((tool) => tool.startsWith('mcp__legacy__'))).toBe(false);
  expect(first?.tools).not.toContain('ToolSearch');
  // One process per server; the user's `echo` never runs (the project's replaced it whole).
  const [echoPid] = await starts(ws, 'echo');
  expect(await starts(ws, 'echo')).toHaveLength(1);
  expect(await starts(ws, 'user-echo')).toEqual([]);
  const [notesPid] = await starts(ws, 'notes');
  expect(await starts(ws, 'notes')).toHaveLength(1);
  expect(echoPid !== undefined && alive(echoPid)).toBe(true);

  await focusMain(app);
  const settings = await openMcp(page);
  const echoRow = server(settings, 'echo');
  await expect(echoRow).toHaveAttribute('data-state', 'connected');
  await expect(echoRow.getByTestId('mcp-source')).toHaveText(path.join(ws, '.mcp.json'));
  await expect(echoRow).toContainText('Local command (stdio) · Project · 3 tools');
  await expect(echoRow).toContainText('used by 1 session');
  const notes = server(settings, 'notes');
  await expect(notes).toHaveAttribute('data-state', 'connected');
  await expect(notes.getByTestId('mcp-source')).toHaveText(path.join(userDataDir, 'settings.json'));
  await expect(notes).toContainText('Local command (stdio) · User · 5 tools');
  for (const [name, transport, reason] of [
    ['legacy', 'SSE', 'the SSE transport is deprecated'],
    ['sockets', 'WebSocket', 'PiArc does not support the WebSocket transport'],
  ] as const) {
    const row = server(settings, name);
    await expect(row).toHaveAttribute('data-state', 'unsupported');
    await expect(row.getByTestId('mcp-state')).toHaveText('Not supported');
    await expect(row).toContainText(`${transport} · Project`);
    await expect(row.getByTestId('mcp-tools')).toHaveCount(0);
    await expect(row.getByTestId('mcp-error')).toContainText(reason);
    await expect(row.getByTestId('mcp-reconnect')).toHaveCount(0);
  }
  // The user's `echo` is replaced as a whole by the project's.
  await expect(settings.getByTestId('mcp-overridden')).toContainText(
    `echo in ${path.join(userDataDir, 'settings.json')} is replaced by the one in ${path.join(ws, '.mcp.json')}`,
  );
  await settings.screenshot({ path: path.join(EVIDENCE, 'mcp-page-en.png') });
  for (const name of ['echo', 'notes', 'legacy', 'sockets']) {
    await server(settings, name).screenshot({ path: path.join(EVIDENCE, `mcp-${name}-en.png`) });
  }
  await settings
    .getByTestId('mcp-overridden')
    .screenshot({ path: path.join(EVIDENCE, 'mcp-overridden-en.png') });

  // Turning `echo` off ends its process; turning it on reconnects it for the running session.
  await echoRow.getByTestId('mcp-disable').click();
  await expect(echoRow).toHaveAttribute('data-state', 'disabled');
  await expect(echoRow.getByTestId('mcp-state')).toHaveText('Turned off');
  await expect(echoRow.getByTestId('mcp-enable')).toBeVisible();
  await expect.poll(() => echoPid !== undefined && alive(echoPid), { timeout: 10_000 }).toBe(false);
  await echoRow.screenshot({ path: path.join(EVIDENCE, 'mcp-echo-disabled.png') });
  await echoRow.getByTestId('mcp-enable').click();
  await expect(echoRow).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  await expect(echoRow).toContainText('3 tools');
  const echoPids = await starts(ws, 'echo');
  expect(echoPids).toHaveLength(2);
  expect(alive(echoPids[1] ?? 0)).toBe(true);

  // Reconnecting `notes` replaces its connection.
  await notes.getByTestId('mcp-reconnect').click();
  await expect(notes).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  await expect(notes).toContainText('5 tools');
  await expect.poll(async () => (await starts(ws, 'notes')).length).toBe(2);
  await expect
    .poll(() => notesPid !== undefined && alive(notesPid), { timeout: 10_000 })
    .toBe(false);
  await expect(settings.getByRole('alert')).toHaveCount(0);

  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(server(settings, 'legacy').getByTestId('mcp-state')).toHaveText('不支持');
  await expect(echoRow.getByTestId('mcp-state')).toHaveText('已连接');
  await settings.screenshot({ path: path.join(EVIDENCE, 'mcp-page-zh-CN.png') });

  // Configuration diagnostics name the servers PiArc cannot use.
  await prefer(page, { key: 'language', value: 'en' });
  await settings.getByTestId('settings-nav-diagnostics').click();
  const issues = settings.getByTestId('diagnostics-mcp');
  await expect(issues.getByTestId('diagnostics-mcp-issue')).toHaveCount(2);
  await expect(issues.locator('[data-server="legacy"]')).toContainText(
    'legacy (SSE) is not supported:',
  );
  await expect(issues.locator('[data-server="sockets"]')).toContainText(
    'sockets (WebSocket) is not supported:',
  );
  await issues.scrollIntoViewIfNeeded();
  await issues.screenshot({ path: path.join(EVIDENCE, 'diagnostics-mcp-en.png') });
});
