import { expect, test } from './sessions.js';
import { idle, openSession, prefer } from './t19.js';

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

test('the rail slides in and out, and a held card lifts while the others make room', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'Rail motion', 't27-usage', 'Measure the window');
  await idle(page);
  await page.getByTestId('usage-ring').click();
  const rail = page.getByTestId('panel-area-rail');
  await expect(rail).toHaveAttribute('data-state', 'open');
  const full = await rail.evaluate((el) => el.getBoundingClientRect().width);
  expect(full).toBeGreaterThan(200);
  await page.screenshot({ path: info.outputPath('rail-light.png') });

  // Closing eases the width to nothing, then the rail goes; opening eases it back.
  const toggle = page.getByTestId('tool-rail');
  await toggle.click();
  await expect(rail).toHaveAttribute('data-state', 'closed');
  const closing = await rail.evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(el.getBoundingClientRect().width);
        }, 90);
      }),
  );
  expect(closing).toBeGreaterThan(0);
  expect(closing).toBeLessThan(full);
  await expect(rail).toHaveCount(0);
  await toggle.click();
  await expect(rail).toHaveAttribute('data-state', 'open');
  const opening = await rail.evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(el.getBoundingClientRect().width);
        }, 90);
      }),
  );
  expect(opening).toBeGreaterThan(0);
  expect(opening).toBeLessThan(full);
  await expect.poll(() => rail.evaluate((el) => el.getBoundingClientRect().width)).toBe(full);

  // Hold the context card by its heading and carry it above the environment card.
  const sections = rail.locator('.rail-section');
  const order = () =>
    sections.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-section')));
  const before = await order();
  expect(before.slice(0, 2)).toEqual(['environment', 'context']);
  const heading = rail.locator('.rail-section[data-section="context"] .rail-heading');
  const envCard = rail.locator('.rail-section[data-section="environment"]');
  const box = await heading.boundingBox();
  const envBox = await envCard.boundingBox();
  if (!box || !envBox) throw new Error('rail cards not laid out');
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, envBox.y + 4, { steps: 12 });
  const held = rail.locator('.rail-section[data-section="context"]');
  await expect(held).toHaveAttribute('data-held', 'pointer');
  // The environment card slides down to open the slot; no insertion line is drawn.
  await expect
    .poll(() => envCard.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42))
    .toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath('rail-dragging.png') });
  await page.mouse.up();
  await expect.poll(order).toEqual(['context', 'environment', ...before.slice(2)]);
  await expect(held).not.toHaveAttribute('data-held');
  // The dropped card settles into its slot; nothing stays offset.
  await expect
    .poll(() =>
      sections.evaluateAll((elements) =>
        elements.every((el) => getComputedStyle(el).transform === 'none'),
      ),
    )
    .toBe(true);
  // A drag is not a click: the card did not collapse.
  await expect(rail.getByTestId('panel-tab-context')).toHaveAttribute('aria-expanded', 'true');

  // Escape while holding puts the card back.
  const envHeading = rail.locator('.rail-section[data-section="environment"] .rail-heading');
  const eb = await envHeading.boundingBox();
  if (!eb) throw new Error('environment heading not laid out');
  await page.mouse.move(eb.x + 40, eb.y + eb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x + 40, eb.y - 200, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(order).toEqual(['context', 'environment', ...before.slice(2)]);

  // Collapsing eases the body closed.
  await rail.getByTestId('panel-tab-context').click();
  await expect(rail.getByTestId('panel-tab-context')).toHaveAttribute('aria-expanded', 'false');
  await expect(held.locator('.rail-section-body')).toBeHidden();
  await rail.getByTestId('panel-tab-context').click();
  await expect(held.locator('.rail-section-body')).toBeVisible();

  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
  // A theme change repaints the cards at once (no eased background).
  await expect(held).toHaveCSS('background-color', 'rgb(34, 34, 34)');
  await page.screenshot({ path: info.outputPath('rail-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'system' });
});

test('in a narrow window the rail slides over the conversation and back out', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'Rail overlay', 't27-usage', 'Measure the window');
  await idle(page);
  // A tool tile beside the conversation leaves it narrow.
  await page.getByTestId('tool-files').click();
  const frame = page.locator('.workspace-primary-frame');
  await expect.poll(() => frame.evaluate((el) => el.clientWidth)).toBeLessThan(660);
  const rail = page.getByTestId('panel-area-rail');
  const toggle = page.getByTestId('tool-rail');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(rail).toHaveAttribute('data-state', 'open');
  await expect(rail).toHaveCSS('position', 'absolute');
  // Fully on screen, cards inside the window, nothing scrolls sideways.
  await expect
    .poll(() =>
      rail.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.right <= window.innerWidth + 0.5 && box.left >= 0;
      }),
    )
    .toBe(true);
  expect(
    await rail.locator('.rail-sections').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('rail-overlay.png') });
  // The backdrop closes it; it slides out before it goes.
  const samples = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        document.querySelector<HTMLElement>('.rail-backdrop')?.click();
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector<HTMLElement>('[data-testid="panel-area-rail"]');
          out.push(
            `${String(Math.round(performance.now() - t0))}:${el ? `${el.dataset.state ?? ''}/${getComputedStyle(el).translate}` : 'gone'}`,
          );
          if (el && out.length < 60) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
  );
  // Part of the way out on some frame, gone at the end.
  const offsets = samples.flatMap((sample) => {
    const match = /closed\/([\d.]+)%/u.exec(sample);
    return match ? [Number(match[1])] : [];
  });
  expect(offsets.some((value) => value > 10 && value < 90)).toBe(true);
  expect(samples.at(-1)).toMatch(/gone$/u);
  await expect(rail).toHaveCount(0);
});
