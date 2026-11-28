// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest on page-model.fixture.ts; upstream tests 73-119, from "Page
// evaluate preserves a large nested JSON argument" to "Page keyboard maps portable editing
// shortcuts on macOS". page.fetch saveAs is refused, so the two saveAs tests check the refusal;
// keyboard paste has no clipboard, so the four paste tests check the paste event,
// Input.insertText and the refusal of { html }.

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import { CdpRequestTimeoutError } from './browser-runtime.js';
import type { CdpObject } from './cdp-types.js';
import {
  cdpCalls,
  openTestPage,
  rejection,
  taskForRound,
  untyped,
  withFixture,
  type Fixture,
  type RecordedCdpCall,
} from './page-model.fixture.js';

/** The recorded `services.cdp` calls of one method. */
function cdpOf(fixture: Fixture, method: string): RecordedCdpCall[] {
  return cdpCalls(fixture).filter((call) => call.method === method);
}

/** The raw `fixture.calls` entries of one CDP method (upstream checks their length). */
function rawCdpOf(fixture: Fixture, method: string): unknown[][] {
  return fixture.calls.filter(([kind, name]) => kind === 'cdp' && name === method);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A `Runtime.callFunctionOn` whose declaration contains `marker`. */
function callFunctionOnWith(fixture: Fixture, marker: string): RecordedCdpCall[] {
  return cdpOf(fixture, 'Runtime.callFunctionOn').filter(({ params }) =>
    text(params.functionDeclaration).includes(marker),
  );
}

/** The `Input.dispatchMouseEvent` params of the recorded calls. */
function mouseEvents(fixture: Fixture): RecordedCdpCall[] {
  return cdpOf(fixture, 'Input.dispatchMouseEvent');
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

test('Page evaluate preserves a large nested JSON argument', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/evaluate-complex');
    const argument = {
      marker: '复杂 input 😀 quotes: " \' ` and a newline\n',
      config: {
        enabled: true,
        nullable: null,
        flags: [true, false, null],
        nested: { level: { value: '深层值' } },
      },
      rows: Array.from({ length: 128 }, (_, index) => ({
        id: index,
        label: `row-${String(index)}-数据`,
        tags: [`tag-${String(index % 7)}`, '共享', `quoted-"${String(index)}"`],
        metrics: { value: index * 3, valid: index % 2 === 0 },
      })),
    };

    const result = await page.evaluate((input: unknown) => input, argument);

    expect(result).toEqual(argument);
    expect(fixture.activeTarget()).toBe(page.targetId);
  });
});

test('Page evaluate preserves user exceptions that resemble protocol timeouts', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('userTimeoutLikeError')
        ) {
          return {
            result: {
              type: 'object',
              subtype: 'error',
              description: 'Error: Execution was terminated',
            },
            exceptionDetails: { text: 'Uncaught' },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/evaluate');

    const error = await rejection(
      page.evaluate(function userTimeoutLikeError() {
        throw new Error('Execution was terminated');
      }),
    );
    expect(Reflect.get(error, 'code')).toBeUndefined();
    expect(error.message).toMatch(/Execution was terminated/);
  });
});

test('Page.waitForFunction gives one predicate the remaining overall timeout', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let timedCall: { params: CdpObject; timeoutMs: number | undefined } | undefined;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('__egoWaitForFunction')
        ) {
          timedCall = { params, timeoutMs };
          return {
            result: {
              type: 'object',
              value: {
                matched: true,
                url: 'https://example.test/wait',
                title: 'wait',
              },
            },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/wait');

    expect(
      await page.waitForFunction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return true;
        },
        undefined,
        { timeout: 2_500 },
      ),
    ).toBe(true);
    expect(timedCall?.params.timeout).toBe(2_500);
    expect(timedCall?.timeoutMs).toBe(2_750);
  });
});

test('Page evaluate gives synchronous code an execution deadline', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let first = true;
    let timedCall: { params: CdpObject; timeoutMs: number | undefined } | undefined;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          first &&
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('__egoPageEvaluate')
        ) {
          first = false;
          timedCall = { params, timeoutMs };
          throw new Error('Execution was terminated');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/evaluate');

    const error = await rejection(
      page.evaluate(() => {
        for (;;) {
          // Spin until the Page stops the script.
        }
      }),
    );
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      executionStopped: true,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(error.message).toMatch(/execution was stopped/i);
    expect(timedCall?.params.timeout).toBe(14_000);
    expect(timedCall?.timeoutMs).toBe(15_000);
    expect(await page.evaluate((value: unknown) => value, 'ready')).toEqual('ready');
  });
});

test('Page evaluate distinguishes a responsive pending promise from a stuck renderer', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let first = true;
    let probes = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          first &&
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('__egoPageEvaluate')
        ) {
          first = false;
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        if (method === 'Runtime.evaluate' && params.expression === '1') {
          probes += 1;
          return { result: { type: 'number', value: 1 } };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/evaluate');

    const error = await rejection(page.evaluate(() => new Promise(() => undefined)));
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      executionStopped: false,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(error.message).toMatch(/still pending/i);
    expect(probes).toBe(1);
    expect(cdpOf(fixture, 'Runtime.terminateExecution')).toEqual([]);
  });
});

test('Page evaluate terminates execution only after its health probe also times out', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let initial = true;
    let healthChecks = 0;
    let terminateCalls = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          initial &&
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('__egoPageEvaluate')
        ) {
          initial = false;
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        if (method === 'Runtime.evaluate' && params.expression === '1') {
          healthChecks += 1;
          if (healthChecks === 1) {
            throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
          }
          return { result: { type: 'number', value: 1 } };
        }
        if (method === 'Runtime.terminateExecution') {
          terminateCalls += 1;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/evaluate');

    const error = await rejection(
      page.evaluate(() => {
        for (;;) {
          // Spin until the Page stops the script.
        }
      }),
    );
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      executionStopped: true,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(error.message).toMatch(/renderer stopped responding/i);
    expect(terminateCalls).toBe(1);
    expect(healthChecks).toBe(2);
  });
});

test('Page evaluate retries when termination is consumed by the first recovery probe', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let initial = true;
    let healthChecks = 0;
    let terminateCalls = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (
          initial &&
          method === 'Runtime.evaluate' &&
          text(params.expression).includes('__egoPageEvaluate')
        ) {
          initial = false;
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        if (method === 'Runtime.evaluate' && params.expression === '1') {
          healthChecks += 1;
          if (healthChecks === 1) {
            throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
          }
          if (healthChecks === 2) {
            throw new Error('Execution was terminated');
          }
          return { result: { type: 'number', value: 1 } };
        }
        if (method === 'Runtime.terminateExecution') {
          terminateCalls += 1;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/evaluate');

    const error = await rejection(
      page.evaluate(() => {
        for (;;) {
          // Spin until the Page stops the script.
        }
      }),
    );
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      executionStopped: true,
      pageResponsive: true,
    });
    expect(terminateCalls).toBe(1);
    expect(healthChecks).toBe(3);
  });
});

test('Page fetch activates its target and returns a structured non-2xx response', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    const response = await first.fetch('/api/teapot', {
      method: 'POST',
      headers: { 'x-request': 'page-fetch' },
      body: 'payload',
      timeout: 250,
    });

    expect(response).toEqual({
      ok: false,
      status: 418,
      statusText: "I'm a Teapot",
      url: 'https://example.test/api/teapot',
      headers: {
        'content-type': 'text/plain',
        'x-fixture': 'page-fetch',
      },
      body: 'short and stout',
    });
    expect(fixture.activeTarget()).toBe(first.targetId);
    const fetchCall = cdpOf(fixture, 'Runtime.evaluate').find(
      ({ params }) =>
        text(params.expression).includes('__egoPageEvaluate') &&
        text(params.expression).includes('window.fetch'),
    );
    const argumentMatch = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(
      text(fetchCall?.params.expression),
    );
    const encoded = argumentMatch?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(text(JSON.parse(encoded ?? '""')))).toEqual({
      url: '/api/teapot',
      options: {
        method: 'POST',
        headers: { 'x-request': 'page-fetch' },
        body: 'payload',
      },
      timeoutMs: 250,
      responseType: 'text',
    });
    expect(fetchCall?.sessionId).toBe('session:target-1');
    expect(fetchCall?.timeoutMs).toBe(1_250);
  });
});

test('Page fetch validates its JSON options and millisecond timeout', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/fetch');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(page.fetch('/api/text', { timeout: 0 })).rejects.toThrow(
      /positive number of milliseconds/,
    );
    await expect(page.fetch('/api/text', untyped({ signal: {} }))).rejects.toThrow(
      /page\.fetch received unknown option: signal/,
    );
    await expect(page.fetch('/api/text', { headers: untyped(cyclic) })).rejects.toThrow(
      /headers must be an object with string values/,
    );
  });
});

test('Page fetch reports browser CORS failures without an evaluation wrapper', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/fetch');
    fixture.failNextFetch(
      'page.fetch uses window.fetch and obeys browser CORS. Request "https://cdn.example.test/image.png" from "https://example.test" failed: TypeError: Failed to fetch',
    );

    const error = await rejection(page.fetch('https://cdn.example.test/image.png'));
    expect(error.message).toMatch(/page\.fetch uses window\.fetch/);
    expect(error.message).toMatch(/obeys browser CORS/);
    expect(error.message).not.toMatch(/JavaScript evaluation failed/);
  });
});

// PiArc: the script host cannot write files, so a binary save is refused before any request
// instead of writing the body to the path (upstream asserts the written bytes).
test('Page fetch saves a binary response without converting it to text', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/fetch');
    fixture.calls.length = 0;

    await expect(page.fetch('/image.png', { saveAs: '/tmp/downloads/image.png' })).rejects.toThrow(
      /saveAs is not supported.*cannot write files.*download\.saveAs\(path\)/,
    );
    expect(fixture.calls).toEqual([]);
  });
});

// PiArc: every saveAs is refused before requesting, a relative one included.
test('Page fetch rejects a relative saveAs path before requesting', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/fetch');
    fixture.calls.length = 0;

    await expect(page.fetch('/image.png', { saveAs: './image.png' })).rejects.toThrow(
      /page\.fetch saveAs is not supported/,
    );
    expect(fixture.calls).toEqual([]);
  });
});

test('Page click fails closed when native mouse dispatch times out', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'Existing user page',
      active: false,
    });
    const task = taskForRound(fixture, 'round-a', { pageBudget: 2 });
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');
    fixture.openPopupOnNextClick('https://example.test/popup');
    fixture.timeoutNextMouseDispatch();

    await expect(first.click('#open-popup')).rejects.toThrow(
      /CDP request timed out: Input\.dispatchMouseEvent/,
    );
    const inventory = await task.tabs();
    expect(
      inventory.find((item) => item.targetId === 'target-user')?.label,
      'a tab that existed before the action must remain untracked',
    ).toBeUndefined();
    expect(inventory.some((item) => item.targetId === 'target-3')).toBe(false);
    expect(mouseEvents(fixture).some(({ sessionId }) => sessionId === 'session:target-1')).toBe(
      true,
    );
    expect(fixture.activeTarget(), 'click must leave its Page active').toBe('target-1');
  });
});

test('Page click returns a pending JavaScript dialog without waiting for input completion', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/dialog');
    fixture.openDialogOnNextClick();

    expect(await page.click('#open-dialog')).toEqual({
      dialog: {
        type: 'alert',
        message: 'Confirm action',
        url: 'https://example.test/dialog',
      },
    });
    expect(await page.info()).toEqual({
      dialog: {
        type: 'alert',
        message: 'Confirm action',
        url: 'https://example.test/dialog',
      },
    });

    const activationsBeforeHandle = cdpOf(fixture, 'Target.activateTarget').length;
    expect(await page.acceptDialog()).toBe(true);
    expect(await page.acceptDialog()).toBe(false);
    expect(
      cdpOf(fixture, 'Target.activateTarget').length,
      'handling a modal dialog must not re-activate its already active Page',
    ).toBe(activationsBeforeHandle);
    expect(
      cdpOf(fixture, 'Page.handleJavaScriptDialog').some(
        ({ sessionId }) => sessionId === 'session:target-1',
      ),
    ).toBe(true);
    expect((await page.info()).url).toBe('https://example.test/dialog');
  });
});

test('a no-dialog response keeps current snapshot refs', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/dialog');
    await page.snapshot({ scope: 'full_page' });

    expect(
      fixture.services.pageRefs.forTarget(String(page.targetId)).get('21')?.backendNodeId,
    ).toBe(21);
    expect(await page.dismissDialog()).toBe(false);
    expect(
      fixture.services.pageRefs.forTarget(String(page.targetId)).get('21')?.backendNodeId,
      'an idempotent no-dialog call must not invalidate an unchanged DOM',
    ).toBe(21);
  });
});

test('Page accepts prompt text and dismisses dialogs on its own session', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');

    fixture.openDialogOnNextClick({
      type: 'prompt',
      message: 'Choose a name',
      defaultPrompt: 'guest',
    });
    const promptReceipt = await first.click('#prompt');
    expect(promptReceipt.dialog?.defaultPrompt).toBe('guest');
    expect(await second.dismissDialog()).toBe(false);
    expect(await first.acceptDialog('agent')).toBe(true);

    fixture.openDialogOnNextClick({ type: 'confirm', message: 'Continue?' });
    await first.click('#confirm');
    expect(await first.dismissDialog()).toBe(true);

    expect(
      cdpOf(fixture, 'Page.handleJavaScriptDialog').map(({ params, sessionId }) => [
        params,
        sessionId,
      ]),
    ).toEqual([
      [{ accept: false }, 'session:target-2'],
      [{ accept: true, promptText: 'agent' }, 'session:target-1'],
      [{ accept: false }, 'session:target-1'],
    ]);
  });
});

test('Page fill uses its target session and reports no popup when none opened', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    expect(await first.fill('#text-input', 'filled')).toEqual({});
    const insertText = fixture.calls.find(
      ([kind, method]) => kind === 'cdp' && method === 'Input.insertText',
    );
    expect(insertText).toEqual(['cdp', 'Input.insertText', { text: 'filled' }, 'session:target-1']);
    expect(
      callFunctionOnWith(fixture, 'fillPreparation').length,
      'fill must validate and select the target element',
    ).toBeGreaterThan(0);
    expect(
      fixture.calls.find(([kind]) => kind === 'showAgentMousePosition'),
      'fill must move the visible agent cursor to its focused element',
    ).toEqual(['showAgentMousePosition', 40, 60]);
    expect(
      mouseEvents(fixture),
      'the fill cursor hint must not synthesize a website mouse event',
    ).toEqual([]);
    expect(
      callFunctionOnWith(fixture, "dispatchEvent(new Event('change'"),
      'ordinary text fill must rely on native input instead of duplicate synthetic events',
    ).toEqual([]);
    expect(fixture.activeTarget(), 'fill must leave its Page active').toBe('target-1');
  });
});

test('Page fill retries an unchanged contenteditable once with a real click', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/editor');
    fixture.configureFill({
      kind: 'contenteditable',
      initialText: 'old text',
      ignoreInsertions: 1,
    });
    fixture.calls.length = 0;

    expect(await page.fill('[contenteditable]', 'new text')).toEqual({});
    expect(fixture.fillText()).toBe('new text');
    expect(
      cdpOf(fixture, 'Input.insertText').length,
      'the standard input attempt should run once before the pointer fallback',
    ).toBe(2);
    expect(
      mouseEvents(fixture).map(({ params }) => params.type),
      'the fallback should perform exactly one real click',
    ).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
});

test('Page fill refuses a pointer fallback that would activate an interactive descendant', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/editor');
    fixture.configureFill({
      kind: 'contenteditable',
      initialText: 'linked text',
      ignoreInsertions: 1,
    });
    fixture.configureUnsafeFillActivation('<a href="https://example.test/link">');
    fixture.calls.length = 0;

    const error = await rejection(page.fill('[contenteditable]', 'replacement'));
    expect(Reflect.get(error, 'kind')).toBe('permanent');
    expect(error.message).toMatch(/cannot safely activate.*<a href=/i);
    expect(
      mouseEvents(fixture),
      'a fill fallback must not click an interactive descendant',
    ).toEqual([]);
  });
});

test('Page fill rejects when a contenteditable still ignores the pointer fallback', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/editor');
    fixture.configureFill({
      kind: 'contenteditable',
      initialText: 'old text',
      ignoreInsertions: 2,
    });

    await expect(page.fill('[contenteditable]', 'new text')).rejects.toThrow(
      /did not accept the text.*click the editor and use page\.keyboard/i,
    );
    expect(fixture.fillText()).toBe('old text');
  });
});

test('Page fill retries an unchanged regular input once with a real click', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/form');
    fixture.configureFill({ kind: 'input', ignoreInsertions: 1 });
    fixture.calls.length = 0;

    expect(await page.fill('input[name=email]', 'user@example.test')).toEqual({});
    expect(fixture.fillText()).toBe('user@example.test');
    expect(mouseEvents(fixture).map(({ params }) => params.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });
});

test('Page fill accepts application formatting without a pointer retry', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/formatted');
    fixture.configureFill({
      kind: 'input',
      initialText: '$600,000',
      transform: (value) => `$${Number(value).toLocaleString('en-US')}`,
    });
    fixture.calls.length = 0;

    expect(await page.fill('#price', '610000')).toEqual({});
    expect(fixture.fillText()).toBe('$610,000');
    expect(
      cdpOf(fixture, 'Input.insertText').length,
      'a semantically equivalent formatted value must not be typed twice',
    ).toBe(1);
  });
});

test('Page fill retries an appended value and accepts the transformed retry', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/formatted');
    fixture.configureFill({
      kind: 'input',
      initialText: '$600,000',
      transform: (value, current, attempt) =>
        attempt === 1 ? current + value : `$${Number(value).toLocaleString('en-US')}`,
    });
    fixture.calls.length = 0;

    expect(await page.fill('#price', '610000')).toEqual({});
    expect(fixture.fillText()).toBe('$610,000');
    expect(cdpOf(fixture, 'Input.insertText').length).toBe(2);
  });
});

test('Page fill accepts a controlled component transformation', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/controlled');
    fixture.configureFill({
      kind: 'input',
      initialText: 'old',
      transform: (value) => value.toUpperCase(),
    });

    expect(await page.fill('#controlled', 'hello')).toEqual({});
    expect(fixture.fillText()).toBe('HELLO');
  });
});

test('Page selectOption selects values through the addressed Page', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/form');

    expect(await page.selectOption('#country', 'nl')).toEqual(['nl']);
    expect(await page.selectOption('#tags', ['one', 'two'])).toEqual(['one', 'two']);
    expect(fixture.selectedValues()).toEqual(['one', 'two']);
  });
});

test('Page selectOption accepts Playwright-style labels, values, and indexes', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/form');

    fixture.configureSelectOptions([
      { value: '09', label: 'September' },
      { value: '10', label: 'October' },
    ]);
    expect(await page.selectOption('#month', { label: 'October' })).toEqual(['10']);
    fixture.configureSelectOptions([
      { value: 'AZ', label: 'Arizona' },
      { value: 'CA', label: 'California' },
    ]);
    expect(await page.selectOption('#state', 'Arizona')).toEqual(['AZ']);
    fixture.configureSelectOptions([
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two' },
    ]);
    expect(await page.selectOption('#tags', [{ value: 'one' }, { index: 1 }])).toEqual([
      'one',
      'two',
    ]);
  });
});

test('Page selectOption validates option descriptors', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/form');

    expect(await page.selectOption('#month', null)).toEqual([]);
    expect(await page.selectOption('#month', [])).toEqual([]);
    await expect(page.selectOption('#month', {})).rejects.toThrow(
      /must specify value, label, or index/,
    );
    await expect(page.selectOption('#month', { index: -1 })).rejects.toThrow(
      /index must be a non-negative integer/,
    );
    await expect(page.selectOption('#month', untyped({ text: 'October' }))).rejects.toThrow(
      /unknown field "text"/,
    );
  });
});

/** A `<option>` as the page-side select function reads it. */
interface FakeOption {
  value: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
}

test('Page selectOption clears existing values before applying new choices', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/form');
    await page.selectOption('#tags', ['one', 'two']);

    const [actionCall] = callFunctionOnWith(fixture, 'selectOptionsForAction');
    expect(actionCall, 'selectOption sends its browser-side action function').toBeDefined();
    // The page evaluates this declaration; evaluate it here the same way.
    const compiled: unknown = globalThis.eval(`(${text(actionCall?.params.functionDeclaration)})`);
    if (typeof compiled !== 'function') throw new TypeError('expected a function declaration');
    const options: FakeOption[] = [
      { value: 'one', label: 'One', selected: false },
      { value: 'two', label: 'Two', selected: false },
      { value: 'undefined', label: 'Undefined', selected: true },
      { value: '', label: 'None', selected: false },
    ];
    const select: Record<string, unknown> = {
      tagName: 'SELECT',
      isConnected: true,
      disabled: false,
      multiple: true,
      options,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        },
      },
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      get selectedOptions() {
        return options.filter((option) => option.selected);
      },
      dispatchEvent: () => true,
    };
    const selectOptionsForAction = (choices: unknown): unknown =>
      Reflect.apply(compiled, select, [choices]);
    const selectedValues = () =>
      options.filter((option) => option.selected).map((option) => option.value);
    const second = options[1];
    if (!second) throw new TypeError('expected the second option');

    expect(selectOptionsForAction(['one', 'two'])).toEqual({
      selected: ['one', 'two'],
    });
    expect(selectOptionsForAction([])).toEqual({ selected: [] });
    expect(selectOptionsForAction([''])).toEqual({
      selected: [''],
    });
    expect(selectedValues(), 'an empty string is a valid option value').toEqual(['']);
    expect(selectOptionsForAction([])).toEqual({ selected: [] });

    second.disabled = true;
    expect(selectOptionsForAction([{ value: 'two' }])).toEqual({
      selected: ['two'],
    });
    expect(selectedValues(), 'a disabled option remains programmatically selectable').toEqual([
      'two',
    ]);

    second.disabled = false;
    select.disabled = true;
    expect(selectOptionsForAction(['one'])).toEqual({
      error: 'element is disabled',
    });
    select.disabled = false;
    expect(selectOptionsForAction(['one'])).toEqual({
      selected: ['one'],
    });

    select.getAttribute = (name: string) => (name === 'aria-disabled' ? 'true' : null);
    expect(selectOptionsForAction(['one'])).toEqual({
      error: 'element is disabled',
    });

    select.getAttribute = () => null;
    second.getAttribute = (name: string) => (name === 'aria-disabled' ? 'true' : null);
    expect(selectOptionsForAction(['two'])).toEqual({
      selected: ['two'],
    });
  });
});

test('Page action receipts do not inject observation probes', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/before');
    fixture.navigateOnNextClick('https://example.test/after');
    fixture.calls.length = 0;

    expect(await page.click('#navigate')).toEqual({});
    expect(await page.url()).toBe('https://example.test/after');
    expect(
      cdpOf(fixture, 'Runtime.evaluate').some(({ params }) =>
        text(params.expression).includes('__egoBrowserActionProbes'),
      ),
    ).toBe(false);
  });
});

test('Page pointer methods dispatch through the addressed target session', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    await first.dblclick('button.primary');
    await first.hover('button.primary');
    await first.dragAndDrop('#source', '#destination');

    const pointerCalls = mouseEvents(fixture);
    expect(pointerCalls.length).toBeGreaterThanOrEqual(7);
    expect(
      pointerCalls.every(({ sessionId }) => sessionId === `session:${String(first.targetId)}`),
      'all pointer events must use the addressed Page session',
    ).toBe(true);
    expect(
      rawCdpOf(fixture, 'Input.dispatchMouseEvent').every((call) => call.length === 4),
      'Page pointer input must use the runtime CDP timeout instead of a 1s action timeout',
    ).toBe(true);
    expect(
      callFunctionOnWith(fixture, '__egoBrowserInputProbes'),
      'Page pointer input must not inject timeout probes into the site',
    ).toEqual([]);
    expect(
      pointerCalls.filter(({ params }) => params.type === 'mousePressed' && params.clickCount === 2)
        .length,
      'dblclick must finish with the second native press',
    ).toBe(1);
    expect(
      pointerCalls.filter(({ params }) => params.type === 'mousePressed').length,
      'dblclick must dispatch two press/release cycles before drag starts',
    ).toBeGreaterThanOrEqual(3);
    expect(fixture.activeTarget()).toBe(first.targetId);
  });
});

test('Page mouse movement updates the Ego Lite agent cursor', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    await page.click('button.primary');
    await page.hover('button.primary');
    await page.dragAndDrop('#source', '#destination');
    await page.mouse.move(80, 100, { steps: 2 });

    const pageMoves = mouseEvents(fixture)
      .filter(({ params }) => params.type === 'mouseMoved')
      .map(({ params }) => [params.x, params.y]);
    const visibleMoves = fixture.calls
      .filter(([kind]) => kind === 'showAgentMousePosition')
      .map(([, x, y]) => [x, y]);

    expect(
      visibleMoves,
      'every successful page mouse move must update the visible agent cursor',
    ).toEqual(pageMoves);
  });
});

test('agent cursor rendering failures do not make successful page input retryable', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      showAgentMousePosition() {
        return Promise.reject(new Error('agent cursor overlay unavailable'));
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.click('button.primary');

    expect(
      mouseEvents(fixture).some(({ params }) => params.type === 'mouseReleased'),
      'the website action still completes when only the visual cursor fails',
    ).toBe(true);
  });
});

test('agent cursor animation does not delay page input completion', async () => {
  await withFixture(async (fixture) => {
    let finishAnimation: () => void = () => undefined;
    const animation = new Promise<void>((resolve) => {
      finishAnimation = resolve;
    });
    const task = taskForRound(fixture, 'round-a', {
      showAgentMousePosition() {
        return animation;
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');

    const outcome = await Promise.race([
      page.mouse.move(20, 30).then(() => 'action-complete'),
      new Promise((resolve) =>
        setTimeout(() => {
          resolve('animation-blocked');
        }, 100),
      ),
    ]);
    finishAnimation();

    expect(outcome).toBe('action-complete');
  });
});

test('Page mouse primitives preserve button state on one target', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    await first.mouse.move(20, 30);
    await first.mouse.down();
    await first.mouse.move(40, 50);
    await first.mouse.up();
    await first.mouse.click(60, 70);
    await first.mouse.wheel(5, 120);

    const pointerCalls = mouseEvents(fixture);
    expect(pointerCalls.length).toBeGreaterThanOrEqual(8);
    expect(
      pointerCalls.every(({ sessionId }) => sessionId === `session:${String(first.targetId)}`),
    ).toBe(true);
    expect(
      pointerCalls.some(({ params }) => params.type === 'mouseMoved' && params.buttons === 1),
      'mouse.move must retain the pressed left button',
    ).toBe(true);
    expect(
      pointerCalls.some(
        ({ params }) =>
          params.type === 'mouseWheel' && params.deltaX === 5 && params.deltaY === 120,
      ),
    ).toBe(true);
    expect(fixture.activeTarget()).toBe(first.targetId);
  });
});

test('Page mouse mirrors Playwright state, steps, and keyboard modifiers', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.down('Shift');
    await page.mouse.move(30, 20, { steps: 3 });
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(60, 50, { steps: 2 });
    await page.mouse.wheel(5, 10);
    await page.mouse.up({ button: 'right' });
    await page.mouse.click(80, 70, { clickCount: 2 });
    await page.keyboard.up('Shift');

    const pointerCalls = mouseEvents(fixture);
    const moves = pointerCalls.filter(({ params }) => params.type === 'mouseMoved');
    expect(moves.slice(0, 3).map(({ params }) => params.x)).toEqual([10, 20, 30]);
    expect(
      moves
        .slice(0, 3)
        .every(({ params }, index) => Math.abs(numberOf(params.y) - (20 * (index + 1)) / 3) < 1e-9),
    ).toBe(true);
    expect(
      pointerCalls.every(({ params }) => params.modifiers === 8),
      'mouse input must carry the keyboard modifier state',
    ).toBe(true);
    expect(
      moves.slice(3, 5).every(({ params }) => params.button === 'right' && params.buttons === 2),
      'mouse moves must retain the last pressed button',
    ).toBe(true);
    expect(
      pointerCalls
        .filter(({ params }) => params.type === 'mousePressed' && params.x === 80)
        .map(({ params }) => params.clickCount),
      'a double click must be two native click cycles',
    ).toEqual([1, 2]);
  });
});

test('Page mouse.wheel scrolls the addressed page', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    const sleepCountBeforeWheel = fixture.sleepDurations.length;
    await first.mouse.wheel(0, 450);

    const scrollCalls = mouseEvents(fixture).filter(({ params }) => params.type === 'mouseWheel');
    expect(
      scrollCalls.length,
      'a large wheel delta should be rendered as a short motion',
    ).toBeGreaterThan(1);
    expect(scrollCalls.reduce((total, { params }) => total + numberOf(params.deltaY), 0)).toBe(450);
    expect(
      scrollCalls.every(({ sessionId }) => sessionId === `session:${String(first.targetId)}`),
    ).toBe(true);
    expect(
      fixture.sleepDurations
        .slice(sleepCountBeforeWheel)
        .reduce((total, duration) => total + duration, 0),
      'the visual transition must stay short',
    ).toBeLessThanOrEqual(100);
    expect(fixture.activeTarget()).toBe(first.targetId);
  });
});

test('Page keyboard press and type use the addressed target session', async () => {
  await withFixture(async (fixture) => {
    // Meta+A's native selectAll editing command is only synthesized on
    // darwin; pin the platform so this assertion doesn't depend on the host
    // OS actually running the test.
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    await first.keyboard.press('Meta+A');
    await first.keyboard.type('hello 世界');

    const isKeyCall = (method: string) =>
      method === 'Input.dispatchKeyEvent' || method === 'Input.insertText';
    const keyCalls = cdpCalls(fixture).filter(({ method }) => isKeyCall(method));
    expect(keyCalls.length).toBeGreaterThanOrEqual(3);
    expect(
      keyCalls.every(({ sessionId }) => sessionId === `session:${String(first.targetId)}`),
    ).toBe(true);
    expect(
      fixture.calls
        .filter(([kind, method]) => kind === 'cdp' && isKeyCall(text(method)))
        .every((call) => call.length === 4),
      'Page keyboard input must use the runtime CDP timeout instead of a 1s action timeout',
    ).toBe(true);
    expect(
      keyCalls.some(
        ({ method, params }) =>
          method === 'Input.dispatchKeyEvent' &&
          params.type === 'rawKeyDown' &&
          params.code === 'KeyA' &&
          params.modifiers === 4 &&
          Array.isArray(params.commands) &&
          params.commands.includes('selectAll'),
      ),
      'Meta+A must retain the native selectAll editing command',
    ).toBe(true);
    expect(
      keyCalls
        .filter(({ method }) => method === 'Input.insertText')
        .map(({ params }) => params.text),
      'characters outside the physical US layout use insertText',
    ).toEqual(['世', '界']);
    expect(fixture.activeTarget()).toBe(first.targetId);
  });
});

test('Page focus and selector-scoped press resolve and focus one element', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/editor');

    expect(await page.focus('[contenteditable]')).toEqual({});
    expect(
      await page.press('[contenteditable]', 'ControlOrMeta+A', {
        delay: 5,
        timeout: 200,
      }),
    ).toEqual({});

    const focusCalls = callFunctionOnWith(fixture, 'focusElementForAction');
    expect(focusCalls.length).toBe(2);
    expect(
      focusCalls.every(({ sessionId }) => sessionId === `session:${String(page.targetId)}`),
    ).toBe(true);
    const keyDown = cdpOf(fixture, 'Input.dispatchKeyEvent').find(
      ({ params }) => params.type === 'rawKeyDown' && params.code === 'KeyA',
    );
    expect(keyDown?.params.modifiers).toBe(4);
  });
});

test('Page focus accepts a uniquely retargeted descendant', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/editor');
    fixture.configureFocusResult({ focused: true, retargeted: 'descendant' });

    expect(await page.focus('#editor-wrapper')).toEqual({});
  });
});

test('Page focus reports ambiguous candidates once as a permanent failure', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/editor');
    fixture.configureFocusResult({
      error: 'element contains multiple editable targets',
      details: {
        tagName: 'TD',
        contentEditable: false,
        tabIndex: -1,
        activeTagName: 'BODY',
        candidateCount: 2,
      },
    });
    fixture.calls.length = 0;

    const error = await rejection(page.focus('td'));
    expect(Reflect.get(error, 'kind')).toBe('permanent');
    expect(error.message).toMatch(
      /multiple editable targets.*td.*contenteditable=false.*tabIndex=-1.*active=body.*candidates=2/i,
    );
    expect(
      callFunctionOnWith(fixture, 'focusElementForAction').length,
      'a permanent focus failure must not consume the action timeout',
    ).toBe(1);
  });
});

/** The index of the paste-event evaluation in `fixture.calls`. */
function pasteEventIndex(fixture: Fixture): number {
  return fixture.calls.findIndex(
    ([kind, method, params]) =>
      kind === 'cdp' &&
      method === 'Runtime.evaluate' &&
      typeof params === 'object' &&
      params !== null &&
      text(Reflect.get(params, 'expression')).includes('new ClipboardEvent("paste"'),
  );
}

// PiArc: the script host has no OS clipboard. Upstream writes the clipboard, presses the native
// shortcut and restores it; the port dispatches a paste event carrying the text and then
// inserts it, without a key press.
test('Page keyboard paste restores the clipboard after the native shortcut', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/table');
    fixture.calls.length = 0;

    expect(await page.keyboard.paste('a\tb\nc\td')).toEqual({});

    const eventIndex = pasteEventIndex(fixture);
    const insertIndex = fixture.calls.findIndex(
      ([kind, method]) => kind === 'cdp' && method === 'Input.insertText',
    );
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeLessThan(insertIndex);
    expect(fixture.calls[eventIndex]?.[3]).toBe(`session:${String(page.targetId)}`);
    const pasteEvent = cdpOf(fixture, 'Runtime.evaluate').find(({ params }) =>
      text(params.expression).includes('new ClipboardEvent("paste"'),
    );
    expect(text(pasteEvent?.params.expression)).toContain(JSON.stringify('a\tb\nc\td'));
    expect(fixture.calls[insertIndex]).toEqual([
      'cdp',
      'Input.insertText',
      { text: 'a\tb\nc\td' },
      `session:${String(page.targetId)}`,
    ]);
    expect(
      cdpOf(fixture, 'Input.dispatchKeyEvent'),
      'paste does not press the native shortcut',
    ).toEqual([]);
  });
});

// PiArc: { text } pastes its text; HTML has no clipboard to carry it, so { text, html } is
// refused before any input.
test('Page keyboard paste forwards plain-text and HTML clipboard representations', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/table');
    fixture.calls.length = 0;

    expect(await page.keyboard.paste({ text: 'A\tB' })).toEqual({});
    expect(cdpOf(fixture, 'Input.insertText').map(({ params }) => params)).toEqual([
      { text: 'A\tB' },
    ]);

    fixture.calls.length = 0;
    await expect(
      page.keyboard.paste({
        text: 'A\tB',
        html: '<table><tr><td>A</td><td>B</td></tr></table>',
      }),
    ).rejects.toThrow(/does not support \{ html \} in PiArc.*paste plain text/i);
    expect(fixture.calls).toEqual([]);
  });
});

test('Page keyboard paste names the invalid argument type', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'win32' });
    const page = await openTestPage(task, 'https://example.test/table');
    fixture.calls.length = 0;

    for (const [value, received] of [
      [undefined, 'undefined'],
      [null, 'null'],
      [['A', 'B'], 'an array'],
      [42, 'number'],
    ] as const) {
      await expect(page.keyboard.paste(untyped(value))).rejects.toThrow(
        new RegExp(`requires a string or \\{ text, html\\? \\}, received ${received}$`),
      );
    }
    // PiArc: no clipboard calls exist; no paste input reached the Page either.
    expect(fixture.calls).toEqual([]);
  });
});

// PiArc: no clipboard to restore; the input failure still surfaces to the caller.
test('Page keyboard paste still restores the clipboard when input fails', async () => {
  await withFixture(async (fixture) => {
    let failNextInsert = true;
    const task = taskForRound(fixture, 'round-a', {
      platform: 'darwin',
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Input.insertText' && failNextInsert) {
          failNextInsert = false;
          throw new Error('keyboard transport failed');
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/table');

    await expect(page.keyboard.paste('one\ttwo')).rejects.toThrow(/keyboard transport failed/);
    expect(failNextInsert).toBe(false);
  });
});

test('Page keyboard type uses the main keyboard for digits and period', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.type('0123456789.');

    const keyDowns = cdpOf(fixture, 'Input.dispatchKeyEvent')
      .filter(({ params }) => params.type === 'keyDown')
      .map(({ params }) => params);
    expect(keyDowns.map(({ key, code, location }) => ({ key, code, location }))).toEqual([
      ...Array.from({ length: 10 }, (_, digit) => ({
        key: String(digit),
        code: `Digit${String(digit)}`,
        location: 0,
      })),
      { key: '.', code: 'Period', location: 0 },
    ]);
  });
});

test('Page keyboard mirrors Playwright key state and the US layout', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.down('Shift');
    await page.keyboard.down('a');
    await page.keyboard.down('a');
    await page.keyboard.up('a');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Meta+V');
    await page.keyboard.press('Control++');
    await page.keyboard.insertText('世界');

    const keyEvents = cdpOf(fixture, 'Input.dispatchKeyEvent').map(({ params }) => params);
    const aDowns = keyEvents.filter(
      (params) => params.type === 'keyDown' && params.code === 'KeyA',
    );
    expect(aDowns[0]?.key).toBe('A');
    expect(aDowns[0]?.text).toBe('A');
    expect(aDowns[0]?.modifiers).toBe(8);
    expect(aDowns[0]?.autoRepeat).toBe(false);
    expect(aDowns[1]?.autoRepeat).toBe(true);

    const paste = keyEvents.find(
      (params) => params.code === 'KeyV' && params.type === 'rawKeyDown',
    );
    expect(paste?.commands).toEqual(['paste']);
    const plus = keyEvents.find((params) => params.key === '+' && params.type === 'rawKeyDown');
    expect(plus?.code).toBe('Equal');
    expect(plus?.modifiers).toBe(2);
    expect(cdpOf(fixture, 'Input.insertText').some(({ params }) => params.text === '世界')).toBe(
      true,
    );
  });
});

test('Page keyboard maps portable editing shortcuts on macOS', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('ControlOrMeta+V');
    await page.keyboard.press('ControlOrMeta+Z');
    await page.keyboard.press('Meta+ArrowUp');
    await page.keyboard.press('Meta+ArrowDown');

    const keyDowns = cdpOf(fixture, 'Input.dispatchKeyEvent')
      .filter(({ params }) => params.type === 'rawKeyDown')
      .map(({ params }) => params);
    const commandFor = (code: string) => keyDowns.find((params) => params.code === code)?.commands;

    expect(commandFor('KeyA')).toEqual(['selectAll']);
    expect(commandFor('KeyC')).toEqual(['copy']);
    expect(commandFor('KeyV')).toEqual(['paste']);
    expect(commandFor('KeyZ')).toEqual(['undo']);
    expect(commandFor('ArrowUp')).toEqual(['moveToBeginningOfDocument']);
    expect(commandFor('ArrowDown')).toEqual(['moveToEndOfDocument']);
    expect(
      keyDowns
        .filter((params) => text(params.code).startsWith('Key'))
        .every((params) => params.modifiers === 4),
      'ControlOrMeta must resolve to Meta on macOS',
    ).toBe(true);
  });
});
