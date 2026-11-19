// W1-A04: on Windows the command tools follow the shells Core finds. With Git for Windows the
// model gets Bash (run by Git Bash) and PowerShell, both asked for in Manual mode; with Git
// hidden it gets PowerShell only and the window says how to install Git.
import path from 'node:path';

import type { MockProcess } from './agent-host.js';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';

test.skip(process.platform !== 'win32', 'Git Bash and PowerShell are the Windows command tools');

const task = 'Print through both shells.';

/** Request bodies the mock received for `scenario`. */
async function bodies(mock: MockProcess, scenario: string): Promise<string[]> {
  const response = await fetch(`${mock.baseUrl}/_piarc/requests`);
  const records = (await response.json()) as { scenario?: string; body?: string }[];
  return records.filter((r) => r.scenario === scenario).map((r) => r.body ?? '');
}

function toolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: { name?: string }[] };
  return (parsed.tools ?? []).map((tool) => tool.name ?? '');
}

test.describe('with Git for Windows', () => {
  test('Bash runs in Git Bash, PowerShell asks in Manual, and Chinese output stays intact', async ({
    app,
    page,
    mock,
    workspaces,
  }, info) => {
    test.setTimeout(120_000);
    const ws = await makeWorkspace(workspaces, 'shells 外壳');
    await openFolder(page, app, ws);
    await startSession(page, task, 'w1-shells');
    await expect(page.getByTestId('permission-mode')).toContainText(/Manual|手动/u);
    await expect(page.getByTestId('notices')).toHaveCount(0);
    const card = page.getByTestId('approval-card');
    for (const [shell, command] of [
      ['bash', 'echo 中文输出 && pwd -W'],
      ['powershell', "Write-Output '中文输出'"],
    ] as const) {
      await expect(card).toHaveAttribute('data-approval-card', 'command');
      await expect(card).toContainText(command);
      await card.screenshot({ path: info.outputPath(`${shell}-approval.png`) });
      await card.getByRole('button', { name: /^(Allow once|仅本次允许)$/u }).click();
    }
    await expect(
      page.getByTestId('agent-message').filter({ hasText: 'Both shells answered.' }),
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: info.outputPath('completed.png') });
    const sent = await bodies(mock, 'w1-shells');
    expect(toolNames(sent[0] ?? '{}')).toEqual(expect.arrayContaining(['Bash', 'PowerShell']));
    // The tool results as the model received them: Git Bash printed the workspace as a
    // Windows path (`pwd -W`), both shells printed the Chinese text.
    const afterBash = sent[1] ?? '';
    expect(afterBash).toContain('中文输出');
    expect(afterBash).toContain(JSON.stringify(ws.replaceAll('\\', '/')).slice(1, -1));
    expect(sent[2] ?? '').toContain('中文输出');
  });
});

test.describe('without Git for Windows', () => {
  // Where Core looks for Git Bash (architecture 6.2.2): the program folders, the per-user
  // install and git.exe on PATH. Point them at empty places; nothing is uninstalled.
  const hidden = path.join(process.env.TEMP ?? '.', 'piarc w1 no git');
  test.use({
    appEnv: {
      ProgramFiles: hidden,
      'ProgramFiles(x86)': hidden,
      ProgramW6432: hidden,
      LOCALAPPDATA: hidden,
      PATH: (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => !/[\\/]git[\\/]/iu.test(dir + '\\'))
        .join(path.delimiter),
    },
  });

  test('the model gets PowerShell only and the window offers Git for Windows', async ({
    app,
    page,
    mock,
    workspaces,
  }, info) => {
    test.setTimeout(120_000);
    const ws = await makeWorkspace(workspaces, 'no git 无 Git');
    await openFolder(page, app, ws);
    await startSession(page, 'Say done.', 't18-chat');
    await expect(page.getByTestId('agent-message').filter({ hasText: 'Done.' })).toBeVisible({
      timeout: 30_000,
    });
    const notices = page.getByTestId('notices');
    await expect(notices).toContainText(/Git Bash was not found|没有找到 Git Bash/u);
    await expect(
      notices.getByRole('button', { name: /^(Download|下载) Git for Windows$/u }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath('git-bash-missing.png') });
    const tools = toolNames((await bodies(mock, 't18-chat'))[0] ?? '{}');
    expect(tools).toContain('PowerShell');
    expect(tools).not.toContain('Bash');
  });
});
