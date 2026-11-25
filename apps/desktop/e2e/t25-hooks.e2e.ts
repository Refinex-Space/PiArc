// T25: hooks' messages and errors reach the existing notice bar, labelled with their event, and
// the configuration diagnostics list the parts of the hooks configuration PiArc does not run.
// The hooks are the trusted project's (`.claude/settings.json`), run by Core with the session's
// command shell. Screenshots go to tmp/evidence/T25/.
import { openSettings } from './settings-panel.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T25');

const HOOKS = JSON.stringify({
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '{"systemMessage":"Ticket PIA-42 is in review."}'`,
          },
        ],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: "echo 'lint failed' >&2; exit 1" }] }],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'sleep 1', async: true }] },
    ],
    SubagentStop: [{ hooks: [{ type: 'command', command: 'true' }] }],
  },
});

async function openDiagnostics(page: Page): Promise<Page> {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-diagnostics').click();
  await settings.getByTestId('config-diagnostics').waitFor();
  return settings;
}

test('hook messages and errors show in the notice bar and unsupported hooks in diagnostics', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'hooks 钩子', { '.claude/settings.json': HOOKS });
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'trust');
  await focusMain(app);
  const notices = page.getByTestId('notices');
  await expect(notices.getByRole('alert')).toHaveText(
    [
      'UserPromptSubmit hookTicket PIA-42 is in review.',
      'Stop hook errorexited with code 1: lint failed',
    ],
    { timeout: 30_000 },
  );
  await notices.screenshot({ path: path.join(EVIDENCE, 'notices-en.png') });
  await page.screenshot({ path: path.join(EVIDENCE, 'window-en.png') });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(notices.getByRole('alert').first()).toContainText('UserPromptSubmit hook 消息');
  await expect(notices.getByRole('alert').last()).toContainText('Stop hook 出错');
  await notices.screenshot({ path: path.join(EVIDENCE, 'notices-zh-CN.png') });
  // Dismissing one notice leaves the other.
  await notices.getByRole('alert').first().getByRole('button').click();
  await expect(notices.getByRole('alert')).toHaveCount(1);

  await prefer(page, { key: 'language', value: 'en' });
  const settings = await openDiagnostics(page);
  const hooks = settings.getByTestId('diagnostics-hooks');
  await expect(hooks.getByTestId('diagnostics-hook')).toHaveText([
    /\.claude\/settings\.json \(Claude Code\).*\/hooks\/PreToolUse\/0\/hooks\/0\/async.*async hooks are not supported; this hook does not run/,
  ]);
  // T38 runs SubagentStop hooks: the one in the file is no longer listed as unsupported (R4).
  await hooks.screenshot({ path: path.join(EVIDENCE, 'diagnostics-hooks-en.png') });
});
