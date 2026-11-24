import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

test('the session rail remembers disclosure and pointer or keyboard ordering', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'Rail order', 't27-usage', 'Measure the window');
  await idle(page);
  await page.getByTestId('usage-ring').click();
  const rail = page.getByTestId('panel-area-rail');
  const sections = rail.locator('.rail-section');
  const order = () =>
    sections.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-section')));
  const original = await order();
  expect(original.slice(0, 2)).toEqual(['environment', 'context']);
  const card = rail.getByTestId('context-panel');
  await expect(card.locator('[data-category=free]')).toContainText('180,000');
  await expect(card.locator('[data-category=free]')).toContainText('90%');
  await expect(card.locator('[data-category=toolResults]')).toHaveCount(0);

  const env = rail.getByTestId('panel-tab-environment');
  await env.click();
  await expect(env).toHaveAttribute('aria-expanded', 'false');
  const grip = rail.getByTestId('rail-reorder-context');
  await grip.press('Enter');
  await grip.press('ArrowUp');
  await grip.press('Escape');
  await expect(rail).toBeVisible();
  expect(await order()).toEqual(original);

  await grip.press('Space');
  await grip.press('ArrowUp');
  await grip.press('Space');
  await expect.poll(order).toEqual(['context', 'environment', ...original.slice(2)]);
  await expect(grip).toBeFocused();
  await page.screenshot({ path: info.outputPath('ordered-rail.png') });
  await env.press('Escape');
  await expect(rail).not.toBeVisible();
  await page.getByTestId('usage-ring').click();
  expect(await order()).toEqual(['context', 'environment', ...original.slice(2)]);
  await expect(env).toHaveAttribute('aria-expanded', 'false');
  await rail.getByTestId('rail-reorder-environment').dragTo(grip);
  await expect.poll(order).toEqual(original);
  await expect(rail.getByTestId('rail-reorder-environment')).toBeFocused();
});
