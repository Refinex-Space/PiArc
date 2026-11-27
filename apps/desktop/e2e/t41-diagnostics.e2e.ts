// T41-A04 (and A02, A03 through the window): the Configuration diagnostics page lists every
// source besides the settings files, grouped by kind: `.mcp.json` ("Untrusted, not in effect"
// before the project is trusted), memory files with their imports, rules (a conditional one
// says when it loads), subagent definitions, skills, commands, output styles, and the
// enterprise place ("Not configured"); a rule added while the app runs shows up without
// reopening the window. Screenshots (light, dark, Chinese) go to tmp/evidence/T41/.
import { openSettings } from './settings-panel.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T41');

test('every configuration source is listed with its state and follows an edit', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'sources 来源', {
    '.mcp.json': JSON.stringify({ mcpServers: { api: { command: 'node', args: ['server.js'] } } }),
    'CLAUDE.md': 'Use tabs.\n@docs/style.md\n',
    'docs/style.md': 'Short names.\n',
    '.claude/rules/ts.md': '---\npaths:\n  - "src/**/*.ts"\n---\nStrict types.\n',
    '.claude/agents/reviewer.md':
      '---\nname: reviewer\ndescription: Reviews changes\nfavourite: tea\n---\nReview.\n',
    '.claude/skills/deploy/SKILL.md':
      '---\ndescription: Deploy\nallowed-tools: Bash(npm run deploy)\n---\nDeploy.\n',
    '.claude/commands/fix.md': 'Fix $ARGUMENTS.\n',
    '.claude/output-styles/terse.md': '---\ndescription: Terse\n---\nBe brief.\n',
  });
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'deny');
  await focusMain(app);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-diagnostics').click();
  const diagnostics = settings.getByTestId('config-diagnostics');
  await diagnostics.waitFor();

  // Each kind of source is one tab of the page (ADR-0101).
  const tab = (kind: string) => settings.getByTestId(`diagnostics-tab-${kind}`).click();
  await tab('mcpJson');
  const mcp = settings.getByTestId('diagnostics-kind-mcpJson');
  await expect(mcp.getByTestId('diagnostics-status')).toHaveText('Untrusted, not in effect');
  await tab('memory');
  const memory = settings.getByTestId('diagnostics-kind-memory');
  await memory.getByTestId('diagnostics-details').first().locator('summary').click();
  await expect(memory.getByTestId('diagnostics-key').first()).toContainText('style.md');
  await tab('rule');
  const rules = settings.getByTestId('diagnostics-kind-rule');
  await rules.getByTestId('diagnostics-details').first().locator('summary').click();
  await expect(rules.getByTestId('diagnostics-ignored-key')).toHaveText([
    '/paths Loaded once a matching file is read or written (src/**/*.ts)',
  ]);
  await tab('agent');
  const agents = settings.getByTestId('diagnostics-kind-agent');
  await agents.getByTestId('diagnostics-details').first().locator('summary').click();
  await expect(agents.getByTestId('diagnostics-key')).toHaveText(['/reviewer']);
  await expect(agents.getByTestId('diagnostics-ignored-key')).toContainText([
    '/favourite PiArc does not use this setting',
  ]);
  await tab('skill');
  const skills = settings.getByTestId('diagnostics-kind-skill');
  await skills.getByTestId('diagnostics-details').first().locator('summary').click();
  await expect(skills.getByTestId('diagnostics-ignored-key')).toContainText([
    /Waits until you trust this project/u,
  ]);
  await tab('command');
  await expect(settings.getByTestId('diagnostics-kind-command')).toContainText('fix.md');
  await tab('outputStyle');
  await expect(settings.getByTestId('diagnostics-kind-outputStyle')).toContainText('terse.md');
  await tab('enterprise');
  const enterprise = settings.getByTestId('diagnostics-kind-enterprise');
  await expect(enterprise.getByTestId('diagnostics-status')).toHaveText('Not configured');
  await expect(enterprise).toContainText('Reserved for enterprise policy');

  await tab('mcpJson');
  await mcp.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-sources-light.png') });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-sources-dark.png') });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(mcp.getByTestId('diagnostics-status')).toHaveText('未信任，未生效');
  await tab('enterprise');
  await expect(enterprise.getByTestId('diagnostics-status')).toHaveText('未配置');
  await tab('rule');
  await rules.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-sources-zh-CN-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await prefer(page, { key: 'language', value: 'en' });

  // A rule added while the app runs appears without reopening the window (A03).
  await writeFile(path.join(ws, '.claude', 'rules', 'review.md'), 'Review before pushing.\n');
  await expect(rules.locator('[data-kind="rule"]').filter({ hasText: 'review.md' })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  await rules.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-rule-added.png') });
});
