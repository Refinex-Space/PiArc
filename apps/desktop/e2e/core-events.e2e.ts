// T04: Core loaded in the main process, its event batches routed to windows over
// MessagePorts. A01 (exit after shutdown), A06 (large batch, integrity part), A07 (routing
// per window), A08 (panic boundary), A10 (load path of the packaged app).
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { _electron as electron } from '@playwright/test';

import { appCommand, desktopDir } from './app.js';
import { openProbe, snapshot, startDemo, stopDemo, subscribe, waitForEvents } from './core.js';
import { expect, test } from './fixtures.js';

/** `piarc-core.darwin-arm64.node`, `piarc-core.win32-x64-msvc.node`, … */
function moduleName(): string {
  return process.platform === 'win32'
    ? `piarc-core.win32-${process.arch}-msvc.node`
    : `piarc-core.${process.platform}-${process.arch}.node`;
}

test('loads Core from the expected file and delivers its events to a window', async ({
  app,
  appForm,
}, testInfo) => {
  const { modulePath, loaded } = await app.evaluate(() => {
    const report: object = process.report.getReport();
    const sharedObjects: unknown = 'sharedObjects' in report ? report.sharedObjects : undefined;
    const shared: unknown[] = Array.isArray(sharedObjects) ? sharedObjects : [];
    return {
      modulePath: globalThis.__piarcTestHooks?.modulePath ?? '',
      loaded: shared.filter(
        (file): file is string => typeof file === 'string' && file.endsWith('.node'),
      ),
    };
  });
  if (appForm === 'packaged') {
    // A10: the packaged app loads the module from app.asar.unpacked, never from the archive.
    expect(modulePath.split(path.sep).slice(-3)).toEqual([
      'app.asar.unpacked',
      'native',
      moduleName(),
    ]);
  } else {
    const expected = path.join(
      desktopDir,
      '..',
      '..',
      'target',
      'piarc-core',
      'development',
      moduleName(),
    );
    expect(realpathSync.native(modulePath)).toBe(realpathSync.native(expected));
  }
  expect(existsSync(modulePath)).toBe(true);
  // The operating system's list of loaded libraries names the same file.
  expect(loaded.map((file) => realpathSync.native(file))).toContain(
    realpathSync.native(modulePath),
  );

  const { page } = await openProbe(app);
  await subscribe(page, ['smoke']);
  const id = await startDemo(app, {
    route: 'smoke',
    eventsPerSecond: 5_000,
    maxEvents: 2_000,
    padBytes: 32,
  });
  const route = await waitForEvents(page, 'smoke', 2_000);
  expect(await stopDemo(app, id)).toEqual({ id, emitted: 2_000 });
  expect(route).toMatchObject({
    events: 2_000,
    batchSeqErrors: 0,
    eventSeqErrors: 0,
    malformedBatches: 0,
  });
  expect(route.streams).toEqual({ [String(id)]: { count: 2_000, lastSeq: 2_000 } });
  expect(route.events / route.batches).toBeGreaterThan(1);
  // The page redraws its table every 250 ms; capture it once it shows the final count.
  await expect(page.getByTestId('probe-route-smoke')).toContainText('2000');
  await page.screenshot({ path: testInfo.outputPath('event-probe.png') });
});

test('two windows subscribed to different routes each get only their own batches', async ({
  app,
}) => {
  // A07
  const first = await openProbe(app);
  const second = await openProbe(app);
  await subscribe(first.page, ['alpha']);
  await subscribe(second.page, ['beta']);
  const alpha = await startDemo(app, { route: 'alpha', eventsPerSecond: 4_000, maxEvents: 3_000 });
  const beta = await startDemo(app, { route: 'beta', eventsPerSecond: 4_000, maxEvents: 2_500 });
  await waitForEvents(first.page, 'alpha', 3_000);
  await waitForEvents(second.page, 'beta', 2_500);
  expect(await stopDemo(app, alpha)).toEqual({ id: alpha, emitted: 3_000 });
  expect(await stopDemo(app, beta)).toEqual({ id: beta, emitted: 2_500 });

  const seenByFirst = await snapshot(first.page);
  const seenBySecond = await snapshot(second.page);
  expect(Object.keys(seenByFirst.routes)).toEqual(['alpha']);
  expect(Object.keys(seenBySecond.routes)).toEqual(['beta']);
  expect(seenByFirst.routes.alpha).toMatchObject({
    events: 3_000,
    batchSeqErrors: 0,
    eventSeqErrors: 0,
  });
  expect(seenBySecond.routes.beta).toMatchObject({
    events: 2_500,
    batchSeqErrors: 0,
    eventSeqErrors: 0,
  });
  const routes = await app.evaluate(
    (_electron, ids) => ids.map((id) => globalThis.__piarcTestHooks?.routesOf(id)),
    [first.id, second.id],
  );
  expect(routes).toEqual([['alpha'], ['beta']]);
});

test('a panic in Core becomes an internalError; the main process and Core keep working', async ({
  app,
}) => {
  // A08
  const { page } = await openProbe(app);
  await subscribe(page, ['after-panic', 'core/errors']);
  const thrown = await app.evaluate(() => {
    try {
      globalThis.__piarcTestHooks?.core.triggerPanic();
      return null;
    } catch (error) {
      return error instanceof Error
        ? {
            isError: true,
            message: error.message,
            code: 'code' in error ? error.code : undefined,
            data: 'data' in error ? error.data : undefined,
          }
        : { isError: false };
    }
  });
  expect(thrown).toEqual({
    isError: true,
    message: 'internal error: panic in CoreRuntime.triggerPanic: panic requested by a test',
    code: -32603,
    data: { kind: 'internalError', retryable: false },
  });
  expect(await app.evaluate(() => globalThis.__piarcTestHooks?.core.state)).toBe('running');

  // A panic inside a Core task arrives as an error event.
  await app.evaluate(() => {
    globalThis.__piarcTestHooks?.core.spawnPanickingTask();
    globalThis.__piarcTestHooks?.core.echo('after-panic', 'still alive');
  });
  const errors = await waitForEvents(page, 'core/errors', 1);
  expect(errors.otherEvents[0]).toMatchObject({
    code: -32603,
    data: { kind: 'internalError', retryable: false },
  });
  const after = await waitForEvents(page, 'after-panic', 1);
  expect(after.otherEvents).toEqual([{ echo: 'still alive' }]);
  expect(await page.evaluate(() => window.piarc.getAppVersion())).toMatch(/^\d+\.\d+\.\d+/);
});

test('a batch above 1 MiB reaches the window complete', async ({ app }) => {
  // The integrity half of A06. Transferring the ArrayBuffer is pending ADR-0019: Electron 45
  // cannot transfer an ArrayBuffer through MessagePortMain.
  const { page } = await openProbe(app);
  await subscribe(page, ['large']);
  const pad = 1536 * 1024;
  await startDemo(app, { route: 'large', eventsPerSecond: 4, maxEvents: 3, padBytes: pad });
  const route = await waitForEvents(page, 'large', 3);
  expect(route).toMatchObject({
    events: 3,
    batchSeqErrors: 0,
    eventSeqErrors: 0,
    malformedBatches: 0,
  });
  expect(route.largestBatchBytes).toBeGreaterThan(1024 * 1024);
  // Each event carries `pad` bytes plus about 40 bytes of JSON around it.
  expect(route.bytes).toBeGreaterThanOrEqual(3 * pad);
});

test('unsubscribe stops a route; a reloaded page subscribes again', async ({ app }) => {
  const { page, id } = await openProbe(app);
  await subscribe(page, ['kept', 'dropped']);
  await page.evaluate(() => window.__piarcEventProbe?.unsubscribe('dropped'));
  await app.evaluate(() => {
    globalThis.__piarcTestHooks?.core.echo('dropped', 'not delivered');
    globalThis.__piarcTestHooks?.core.echo('kept', 'delivered');
  });
  await waitForEvents(page, 'kept', 1);
  expect(Object.keys((await snapshot(page)).routes)).toEqual(['kept']);

  await expect(
    page.evaluate(() => window.piarc.subscribeEvents('bad route', () => undefined)),
  ).rejects.toThrow(/route must be/);

  await page.reload();
  await page.getByTestId('event-probe').waitFor();
  await expect
    .poll(() => app.evaluate((_e, wc) => globalThis.__piarcTestHooks?.routesOf(wc), id))
    .toEqual([]);
  await subscribe(page, ['kept']);
  await app.evaluate(() => globalThis.__piarcTestHooks?.core.echo('kept', 'after reload'));
  const route = await waitForEvents(page, 'kept', 1);
  expect(route.otherEvents).toEqual([{ echo: 'after reload' }]);
});

test('the app quits normally while Core is streaming events', async ({
  appForm,
  userDataDir,
}, testInfo) => {
  // A01: quitting runs Core's ordered shutdown, which releases the event callback, and the
  // process exits on its own.
  const { command, args } = appCommand(appForm, [`--user-data-dir=${userDataDir}`]);
  const app = await electron.launch({ executablePath: command, args });
  let output = '';
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      resolve(code);
    }),
  );
  try {
    const { page } = await openProbe(app);
    await subscribe(page, ['quit']);
    await startDemo(app, { route: 'quit', eventsPerSecond: 5_000 });
    await waitForEvents(page, 'quit', 500);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    const code = await Promise.race([
      exited,
      new Promise<'hung'>((resolve) =>
        setTimeout(() => {
          resolve('hung');
        }, 20_000),
      ),
    ]);
    expect(code).toBe(0);
    expect(output).toMatch(/\[core\] shutting down[\s\S]*\[core\] stopped/);
  } finally {
    // Normally the process is gone by now and there is nothing left to close; close() only
    // matters when an assertion above failed while the app was still running.
    await app.close().catch(() => undefined);
    await testInfo.attach('app.log', { body: output, contentType: 'text/plain' });
  }
});
