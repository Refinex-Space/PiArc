// B2 of the built-in browser (ADR-0089, ADR-0091, design addendum B2.2–B2.6): an agent's script
// runs in the sandboxed script host with the browser SDK, drives tabs of its own task space
// through the CDP proxy, reads the main process's snapshot and attaches screenshots. The host
// has no network of its own (THR-05), an endless loop ends at the timeout and the next run
// works, DevTools methods outside the allow list are refused, and the request gate keeps the
// agent's pages to hosts the user allowed: a local port the user opened passes, another one is
// blocked and reported. Runs go through the development test hook `browserScript`: the same
// host, bindings, proxy and gate as a `core/browser` run, without a Core call (so no site card
// can allow anything new).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ElectronApplication, Page } from '@playwright/test';

import type { BrowserObservation, BrowserScriptObservation } from '../src/shared/test-hooks.js';
import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

let server: Server;
let other: Server;
let origin = '';
let otherOrigin = '';
/** Requests each fixture server saw, by path. */
const seen: string[] = [];
const otherSeen: string[] = [];

function pages(): Record<string, string> {
  return {
    '/': [
      '<!doctype html><title>Agent fixture</title>',
      '<h1>Checkout</h1>',
      '<label>City <input id="city" name="city"></label>',
      "<button id=\"save\" onclick=\"document.getElementById('out').textContent = 'Saved ' + document.getElementById('city').value\">Save</button>",
      '<p id="out"></p>',
    ].join(''),
    '/gated': `<!doctype html><title>Gated</title><img id="pixel" src="${otherOrigin}/pixel.png">`,
  };
}

async function listen(record: string[], body: (path: string) => string | undefined) {
  const created = createServer((request, response) => {
    record.push(request.url ?? '');
    const text = body(request.url ?? '/');
    if (text === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(text);
  });
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  return {
    server: created,
    origin: `http://127.0.0.1:${String((created.address() as AddressInfo).port)}`,
  };
}

test.beforeAll(async () => {
  ({ server, origin } = await listen(seen, (path) => pages()[path]));
  ({ server: other, origin: otherOrigin } = await listen(otherSeen, () => 'x'));
});

test.afterAll(async () => {
  for (const each of [server, other]) {
    await new Promise<void>((resolve) =>
      each.close(() => {
        resolve();
      }),
    );
  }
});

async function run(
  app: ElectronApplication,
  sessionId: string,
  script: string,
  timeoutMs = 30_000,
): Promise<BrowserScriptObservation> {
  const answer = await app.evaluate(
    async (_electron, args) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
      return hooks.browserScript(args.sessionId, args.script, args.timeoutMs);
    },
    { sessionId, script, timeoutMs },
  );
  if (answer === null) throw new Error('The run was cancelled');
  return answer;
}

async function observe(app: ElectronApplication, sessionId: string): Promise<BrowserObservation> {
  return app.evaluate(async (_electron, id) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
    return hooks.browser(id);
  }, sessionId);
}

/** The user opens `address` in their own tab of the preview panel. */
async function userOpens(page: Page, address: string): Promise<void> {
  await page.getByTestId('tool-preview').click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
  await expect(page.getByTestId('browser-tab').first()).toHaveText(/Agent fixture/);
}

test('a script drives its task space: snapshot, fill, click, screenshot', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser agent', 't18-chat', 'Hello');
  await idle(page);
  await userOpens(page, `${origin}/`);
  const first = await run(
    app,
    id,
    `const task = await taskSpace("checkout check");
const page = task.page("p1");
await page.goto(${JSON.stringify(`${origin}/`)});
console.log({ space: task.spaceId, title: await page.title() });
console.log(await page.snapshot());`,
  );
  expect(first.error).toBeUndefined();
  expect(first.output).toContain('Agent fixture');
  expect(first.output).toMatch(/button "Save" \[ref=\d+/);
  expect(first.output).toMatch(/textbox "City"/);
  const space = /space: (\d+)/.exec(first.output)?.[1];
  expect(space).toBeDefined();
  // The tab belongs to the agent's Space; the user's own tab stays the user's.
  const tabs = (await observe(app, id)).tabs;
  expect(tabs.some((t) => t.openedBy === 'agent' && t.url.startsWith(origin))).toBe(true);
  expect(tabs.some((t) => t.space === 'user' && t.openedBy === 'user')).toBe(true);

  const second = await run(
    app,
    id,
    `const task = await taskSpace(${String(space)});
const page = task.page("p1");
await page.fill("loc=role:textbox[name='City']", "Paris");
await page.click("text=Save", { label: "save the city" });
await page.waitForFunction(() => document.getElementById("out").textContent.length > 0);
console.log(await page.evaluate(() => document.getElementById("out").textContent));
console.log(await page.screenshot());`,
  );
  expect(second.error).toBeUndefined();
  expect(second.output).toContain('Saved Paris');
  expect(second.images).toHaveLength(1);
  expect(second.images[0]?.mediaType).toBe('image/png');
  expect(second.images[0]?.width).toBeGreaterThan(0);

  const finished = await run(
    app,
    id,
    `const task = await taskSpace(${String(space)});
await task.finish({ keep: [] });
console.log("done");`,
  );
  expect(finished.error).toBeUndefined();
  await expect
    .poll(async () => (await observe(app, id)).tabs.filter((t) => t.openedBy === 'agent').length)
    .toBe(0);
});

test('B2.6: the gate blocks what the user did not allow and reports it', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser gate', 't18-chat', 'Hello');
  await idle(page);
  await userOpens(page, `${origin}/`);
  otherSeen.length = 0;
  const gated = await run(
    app,
    id,
    `const task = await taskSpace("gate check");
const page = task.page("p1");
await page.goto(${JSON.stringify(`${origin}/gated`)});
console.log(await page.evaluate(() => document.getElementById("pixel").naturalWidth));
let opened = "opened";
try { await page.goto(${JSON.stringify(`${otherOrigin}/`)}, { timeout: 5000 }); }
catch (error) { opened = "refused"; }
console.log(opened);
await task.finish({ keep: [] });`,
  );
  expect(gated.output).toContain('refused');
  expect(gated.blockedHosts).toContain(otherOrigin.replace('http://', ''));
  // Neither the image nor the document reached the other server.
  expect(otherSeen).toEqual([]);
});

test('B2.5: the user stops a call, takes the space over and hands it back', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser control', 't18-chat', 'Hello');
  await idle(page);
  await page.getByTestId('tool-preview').click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  // A call that waits: the panel shows the agent at work, and Stop ends the call.
  const waiting = run(
    app,
    id,
    `const task = await taskSpace("control check");
const page = task.page("p1");
console.log({ space: task.spaceId });
await page.waitForTimeout(20000);
console.log("not stopped");`,
  );
  await expect(page.getByTestId('browser-agent-bar')).toBeVisible();
  // The page under the agent takes no pointer input from the user meanwhile (B2.5.1).
  await expect.poll(async () => (await observe(app, id)).shielded).toBe(true);
  // The control bar's Stop (the navigation row has its own while the page loads).
  await page.getByTestId('browser-agent-bar').getByTestId('browser-stop').click();
  const stopped = await waiting;
  expect(stopped.error?.code).toBe('PIARC_STOPPED');
  expect(stopped.output).not.toContain('not stopped');
  const space = /space: (\d+)/.exec(stopped.output)?.[1];
  expect(space).toBeDefined();
  // Between calls the bar and the shield are gone.
  await expect(page.getByTestId('browser-agent-bar')).toBeHidden();
  await expect.poll(async () => (await observe(app, id)).shielded).toBe(false);

  // A call that keeps reading the page; the user takes over and its next read fails.
  const reading = run(
    app,
    id,
    `const task = await taskSpace(${String(space)});
const page = task.page("p1");
for (let i = 0; i < 100; i += 1) {
  await page.evaluate(() => document.title);
  await page.waitForTimeout(200);
}
console.log("never taken over");`,
  );
  await expect(page.getByTestId('browser-takeover')).toBeVisible();
  await page.getByTestId('browser-takeover').click();
  const taken = await reading;
  expect(taken.output).not.toContain('never taken over');
  expect(`${taken.error?.code ?? ''} ${taken.error?.message ?? ''} ${taken.output}`).toContain(
    'EGO_TASK_SPACE_USER_IN_CONTROL',
  );
  await expect(page.getByTestId('browser-hand-back')).toBeVisible();
  // The agent's calls ran script in the page: the user is told before typing secrets.
  await expect(page.getByTestId('browser-tainted')).toBeVisible();
  await page.getByTestId('browser-hand-back').click();
  await expect(page.getByTestId('browser-agent-bar')).toBeHidden();
  const back = await run(
    app,
    id,
    `const task = await taskSpace(${String(space)});
console.log(await task.page("p1").url());
await task.finish({ keep: [] });`,
  );
  expect(back.error).toBeUndefined();
});

test('B2.1.2: a model Browser call runs end to end and shows its screenshot', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'Browser call', 'browser-run', 'Check the browser');
  await idle(page);
  await expect(
    page.getByTestId('agent-message').getByText('The browser opened a blank page'),
  ).toBeVisible();
  const card = page.getByTestId('browser-card');
  await expect(card).toHaveAttribute('data-status', 'completed');
  await expect(card).toContainText('Check the start page');
  // The screenshot the model saw shows in the transcript (ADR-0093).
  await expect(card.getByTestId('browser-shot')).toHaveAttribute('data-state', 'shown');
  await expect(card.getByTestId('browser-shot').locator('img')).toHaveJSProperty('complete', true);
});

test('THR-05: the script host reaches nothing on the network', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(90_000);
  const { id } = await openSession(app, page, workspaces, 'Host isolation', 't18-chat', 'Hello');
  await idle(page);
  seen.length = 0;
  const target = `${origin}/beacon`;
  const answer = await run(
    app,
    id,
    `const results = {};
const attempt = async (name, work) => {
  try { await work(); results[name] = "reached"; } catch (error) { results[name] = "blocked"; }
};
await attempt("fetch", () => fetch(${JSON.stringify(target)}));
await attempt("image", () => new Promise((resolve, reject) => {
  const image = new Image(); image.onload = resolve; image.onerror = reject;
  image.src = ${JSON.stringify(`${target}?image`)};
}));
await attempt("socket", () => new Promise((resolve, reject) => {
  const socket = new WebSocket(${JSON.stringify(target.replace('http:', 'ws:'))});
  socket.onopen = resolve; socket.onerror = reject;
}));
await attempt("import", () => import(${JSON.stringify(`${target}.js`)}));
console.log(JSON.stringify(results));`,
  );
  expect(answer.output).toContain('"fetch":"blocked"');
  expect(answer.output).toContain('"image":"blocked"');
  expect(answer.output).toContain('"socket":"blocked"');
  expect(answer.output).toContain('"import":"blocked"');
  expect(seen.filter((path) => path.startsWith('/beacon'))).toEqual([]);
});

test('an endless loop ends at the timeout and the next run works; refused CDP is reported', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(90_000);
  const { id } = await openSession(app, page, workspaces, 'Host timeout', 't18-chat', 'Hello');
  await idle(page);
  const started = Date.now();
  const stuck = await run(app, id, 'console.log("before"); for (;;) {}', 2_000);
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(stuck.error?.code).toBe('PIARC_TIMEOUT');
  expect(stuck.output).toContain('before');
  const next = await run(app, id, 'console.log(1 + 1);');
  expect(next.error).toBeUndefined();
  expect(next.output.trim()).toBe('2');
  const refused = await run(
    app,
    id,
    `const task = await taskSpace("cdp check");
const page = task.page("p1");
try { await page.cdp("Network.getAllCookies"); console.log("allowed"); }
catch (error) { console.log(String(error.message)); }
await task.finish({ keep: [] });`,
  );
  expect(refused.output).toContain('PIARC_CDP_METHOD_REFUSED');
});
