// T45-A10 (THR-11): the XSS payload set (src/shared/xss-payloads.ts) on every render surface
// besides the transcript (transcript-security.e2e.ts, t19-security.e2e.ts): approval cards (a
// command and a file change), the Changes diff with its file name and an inline comment, the
// settings pages (an MCP server, an extension package, configuration diagnostics values), a
// hook's notice, and OSC 8 links in the terminal panel. Everything shows as text: the page's
// sentinel stays, no element carries an event attribute, no frame, object or foreignObject
// appears, links keep safe schemes, the window does not navigate and the CSP reports nothing.
import { openSettings } from './settings-panel.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

import { XSS_PAYLOADS, XSS_SENTINEL_UNTOUCHED } from '../src/shared/xss-payloads.js';
import { startMock } from './agent-host.js';
import {
  expect,
  focusMain,
  makeWorkspace,
  openFolder,
  startSession,
  test as base,
} from './sessions.js';
import { idle, prefer } from './t19.js';
import {
  cellPoint,
  LINK_MODIFIER,
  linkCalls,
  openPanel,
  recordExternalLinks,
  rowOf,
  run,
  waitForPanel,
} from './terminal-panel.js';
import { watchMarkup } from './transcript.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T45');
const SCENARIO = 't45-xss';
/** Payloads with neither quote, safe inside a shell's single quotes and a JSON string. */
const PLAIN = [
  '<img src=x onerror=window.__piarcXssSentinel=document.domain>',
  '<svg onload=window.__piarcXssSentinel=1><foreignObject><iframe srcdoc=x></iframe></foreignObject></svg>',
  '<a href=javascript:window.__piarcXssSentinel=2>link</a>',
];
/** A file name made of markup; Windows forbids `<` and `>`, so there the name hides it in entities. */
const MARKUP_NAME =
  process.platform === 'win32'
    ? 'notes/&#x3C;img src=x onerror=alert(1)&#x3E; \u202egnp.md'
    : `notes/<img src=x onerror=window.__piarcXssSentinel=3> \u202egnp.md`;
const CONTENT = XSS_PAYLOADS.map((p) => p.markdown).join('\n') + '\n';
const COMMAND = `env echo ${XSS_PAYLOADS.slice(0, 8)
  .map((p) => p.markdown)
  .join(' ')}`;

interface DocumentInspection {
  readonly sentinel: string | undefined;
  readonly violations: readonly string[];
  readonly eventAttributes: readonly string[];
  readonly dangerous: readonly string[];
  readonly unsafeHrefs: readonly string[];
  readonly url: string;
}

/** What the payloads could have left anywhere in `page`'s document. */
function inspectDocument(page: Page): Promise<DocumentInspection> {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll('*')];
    const selectors = [
      'body script',
      'iframe',
      'frame',
      'object',
      'embed',
      'base',
      'foreignObject',
      'form[action]',
      'body meta',
      'body style',
      'animate',
    ];
    return {
      sentinel: globalThis.__piarcXssSentinel,
      violations: globalThis.__piarcCspViolations ?? [],
      eventAttributes: elements.flatMap((element) =>
        element
          .getAttributeNames()
          .filter((name) => name.toLowerCase().startsWith('on'))
          .map((name) => `${element.tagName}[${name}]`),
      ),
      dangerous: selectors.filter((selector) => document.querySelector(selector) !== null),
      unsafeHrefs: [...document.body.querySelectorAll('a[href], [*|href]')]
        .map((element) => element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '')
        .filter((href) => href !== '' && !/^(https?:|mailto:|#)/u.test(href)),
      url: location.href,
    };
  });
}

async function expectInertDocument(page: Page, url: string, where: string): Promise<void> {
  const found = await inspectDocument(page);
  expect(found.sentinel, where).toBe(XSS_SENTINEL_UNTOUCHED);
  expect(found.violations, where).toEqual([]);
  expect(found.eventAttributes, where).toEqual([]);
  expect(found.dangerous, where).toEqual([]);
  expect(found.unsafeHrefs, where).toEqual([]);
  expect(found.url, where).toBe(url);
}

async function expectText(locator: Locator, texts: readonly string[]): Promise<void> {
  for (const text of texts) await expect(locator).toContainText(text);
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern.
  mock: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-t45-xss-'));
    try {
      const file = path.join(dir, 'scenario.json');
      await writeFile(
        file,
        JSON.stringify({
          id: SCENARIO,
          steps: [
            { tool_calls: [{ id: 'toolu_cmd', name: 'Bash', input: { command: COMMAND } }] },
            {
              tool_calls: [
                {
                  id: 'toolu_write',
                  name: 'Write',
                  input: { path: MARKUP_NAME, content: CONTENT },
                },
              ],
            },
            { text: 'Wrote the notes.' },
          ],
        }),
      );
      const mock = await startMock(file);
      try {
        await use(mock);
      } finally {
        mock.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

test('THR-11 approval cards, the Changes diff and its comments show the payloads as text', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(150_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'xss 载荷', { 'notes/.keep': '' });
  await openFolder(page, app, ws);
  // The mock picks the script by the session's first message, so the session starts with it.
  await watchMarkup(page);
  await startSession(page, 'Write the notes.', SCENARIO);
  await focusMain(app);
  const url = page.url();

  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-approval-card', 'command');
  // A long command is folded behind the reading gate; the whole text is one click away.
  await card.getByRole('button', { name: 'Show full request', exact: true }).click();
  await expect(card.locator('.bash-command')).toHaveText(COMMAND);
  await expectInertDocument(page, url, 'command card');
  await card.getByRole('button', { name: 'Decline', exact: true }).click();

  await expect(card).toHaveAttribute('data-approval-card', 'fileChange');
  // The name's markup is text and its right-to-left override a visible marker, not a reordering.
  await expect(card).toContainText((MARKUP_NAME.split('/')[1] ?? '').replace('\u202e', '[U+202E]'));
  await expectInertDocument(page, url, 'file change card');
  await page.screenshot({ path: path.join(EVIDENCE, 'xss-approval-card.png') });
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByTestId('agent-message').last()).toContainText('Wrote the notes.');
  await idle(page);

  await page.getByTestId('panel-tab-changes-card').click();
  await page.getByTestId('changes-open').click();
  const changed = page.locator(`[data-testid=changes-file][data-path="${MARKUP_NAME}"]`);
  await expect(changed).toBeVisible();
  await expectText(
    changed,
    XSS_PAYLOADS.slice(0, 6).map((p) => p.markdown),
  );
  await changed.locator('[data-testid=changes-comment-add][data-side=new][data-line="1"]').click();
  await page.getByTestId('changes-comment-input').fill(PLAIN.join(' '));
  await page.getByTestId('changes-comment-save').click();
  await expect(page.getByTestId('changes-comment').first()).toContainText(PLAIN[0] ?? '');
  await expectInertDocument(page, url, 'Changes diff and comment');
  await page.screenshot({ path: path.join(EVIDENCE, 'xss-changes.png') });
});

test('THR-11 settings pages and a hook notice show names, values and messages as text', async ({
  app,
  page,
  userDataDir,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const home = path.join(userDataDir, 'test-home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: PLAIN[0], env: { PAYLOAD: PLAIN[1] } }),
  );
  const plugin = path.join(userDataDir, 'plugin-src', 'evil');
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'evil', description: PLAIN.join(' '), version: PLAIN[2] }),
  );
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      language: 'en',
      // A valid name with markup in what it runs (a server row) and a name made of markup
      // (listed as a configuration problem).
      mcpServers: {
        evil: { command: PLAIN[1], args: [PLAIN[2]] },
        [`evil${PLAIN[0] ?? ''}`]: { command: 'node' },
      },
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: `printf '%s' '${JSON.stringify({ systemMessage: PLAIN.join(' ') })}'`,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.evaluate(
    (location) => window.piarc.installPackage({ kind: 'directory', location, scope: 'user' }),
    plugin,
  );
  const ws = await makeWorkspace(workspaces, 'settings xss 设置');
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat');
  await focusMain(app);
  await watchMarkup(page);
  const mainUrl = page.url();
  await expect(page.getByTestId('notices')).toContainText(PLAIN[0] ?? '', { timeout: 30_000 });
  await expectInertDocument(page, mainUrl, 'hook notice');

  const settings = await openSettings(page);
  await watchMarkup(settings);
  const settingsUrl = (): string => settings.url();
  const settingsWindow = settings.getByTestId('settings-window');
  for (const [nav, row, text] of [
    ['settings-nav-diagnostics', 'config-diagnostics', PLAIN[0]],
    ['settings-nav-mcp', 'mcp-server', 'evil'],
    ['settings-nav-skills', 'package-row', 'evil'],
  ] as const) {
    await settings.getByTestId(nav).click();
    // Packages list under their tab on "Skills & plugins" (ADR-0102).
    if (row === 'package-row')
      await settings.getByTestId('skills-tab-plugins').check({ force: true });
    await expect(settings.getByTestId(row).first()).toBeVisible();
    await expect(settingsWindow).toContainText(text ?? '');
    await expectInertDocument(settings, settingsUrl(), row);
    await settings.screenshot({ path: path.join(EVIDENCE, `xss-settings-${row}.png`) });
  }
});

test('THR-13 OSC 8 links with script and data targets in the terminal neither open nor navigate', async ({
  app,
  page,
  workspaces,
}) => {
  // cmd prints the fixture through ConPTY. The disallowed protocols have inert targets.
  const windows = process.platform === 'win32';
  const files: Record<string, string> = {};
  if (windows) {
    const link = (target: string, label: string) => `\x1b]8;;${target}\x07${label}\x1b]8;;\x07`;
    files['blocked-links.txt'] = [
      link('javascript:0', 'js'),
      link('data:text/plain,example', 'data'),
      link('vbscript:0', 'vb'),
      'end\r\n',
    ].join(' ');
  }
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces, files);
  await watchMarkup(page);
  const url = page.url();
  await run(
    page,
    windows
      ? 'type blocked-links.txt'
      : "printf '\\033]8;;javascript:window.__piarcXssSentinel=4\\033\\\\js\\033]8;;\\033\\\\ \\033]8;;data:text/html,x\\033\\\\data\\033]8;;\\033\\\\ \\033]8;;vbscript:x\\033\\\\vb\\033]8;;\\033\\\\ end\\n'",
  );
  const line = 'js data vb end';
  await waitForPanel(page, (text) => text.split('\n').includes(line), 'the links');
  const row = await rowOf(page, line);
  await recordExternalLinks(app, 0);
  for (const col of [0, 3, 8]) {
    const point = await cellPoint(page, col, row);
    await page.keyboard.down(LINK_MODIFIER);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(LINK_MODIFIER);
  }
  expect(await linkCalls(app)).toEqual([]);
  await expectInertDocument(page, url, 'terminal panel');
});
