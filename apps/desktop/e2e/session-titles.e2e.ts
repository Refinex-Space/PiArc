// ADR-0106: a new session whose first message is long shows that message first, then the title
// generated from it replaces it in the sidebar and the header without a reload. The title
// request and the first turn reach the mock in either order, so both of its steps answer the
// same line (each streamed slowly enough to see the message first).
import { expect, row, test } from './sessions.js';
import { idle, openSession } from './t19.js';

test.use({ appEnv: { PIARC_TEST_SESSION_TITLES: '1' } });

const LONG =
  '我想系统地学习 Spring Boot，请帮我规划一个从零开始、四周完成的入门学习计划，每周列出主题、要读的文档和一个小练习';
const TITLE = 'Spring Boot 入门学习计划';

test('a long first message gives way to a generated title in place', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { id } = await openSession(app, page, workspaces, 'titles 标题', 'session-title', LONG);
  const header = page.getByTestId('conversation-title');
  const sidebar = row(page, id).getByTestId('session-title');
  await expect(header).toContainText('我想系统地学习');
  await page.screenshot({ path: info.outputPath('session-title-before.png') });
  await expect(header).toHaveText(TITLE, { timeout: 15_000 });
  await expect(sidebar).toHaveText(TITLE);
  // The title settled in place: the same elements, no reload of the page.
  await expect(header.locator('.title-in')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('session-title-after.png') });
  await idle(page);
});
