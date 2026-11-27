// Ported from ego-browser package/ego-browser/src/page-actions.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest, next to driver/page-actions.ts; the services' `cdp` is built
// with `fakeCdp` and answers the unwrapped results the upstream fakes return.

import { expect, test } from 'vitest';

import { fakeCdp } from '../../testing.js';
import type { CdpObject } from '../cdp-types.js';
import { ElementResolutionError } from '../element-resolver.js';
import { RefMap } from '../ref-map.js';
import { clickInPage, type FrameSessions, type PageActionServices } from './page-actions.js';

type Call = [method: string, params: CdpObject, sessionId: string | undefined];

function declaration(params: CdpObject): string {
  const source = params.functionDeclaration;
  return typeof source === 'string' ? source : '';
}

function quietServices(
  calls: Call[],
  handler: (method: string, params: CdpObject, sessionId: string | undefined) => unknown,
  extra: Partial<PageActionServices> = {},
): PageActionServices {
  return {
    cdp: fakeCdp((method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      return handler(method, params, sessionId);
    }),
    showAgentMousePosition: () => Promise.resolve(),
    showAgentTaskState: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    ...extra,
  };
}

/**
 * Services for a top-level raw-selector click: the strict resolver counts and
 * resolves the selector with Runtime.evaluate, the action point comes from the
 * expression that settles layout, and every other page call answers `respond`.
 */
function topLevelClickServices({
  respond = () => ({ ok: true }),
  point = { x: 10, y: 20 },
}: {
  respond?: (params: CdpObject) => unknown;
  point?: unknown;
} = {}) {
  const calls: Call[] = [];
  const services = quietServices(calls, (method, params) => {
    if (method === 'Runtime.evaluate') {
      return params.returnByValue === false
        ? { result: { objectId: 'button-1' } }
        : { result: { value: 1 } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const value = declaration(params).includes('setTimeout(finish') ? point : respond(params);
      return { result: { value } };
    }
    return {};
  });
  return { calls, services };
}

function actionSequence(calls: readonly Call[]): string[] {
  return calls
    .filter(([method]) => method !== 'Runtime.evaluate')
    .map(([method, params]) =>
      method === 'Input.dispatchMouseEvent' ? `${method}:${String(params.type)}` : method,
    );
}

function pageCalls(calls: readonly Call[]): string[] {
  return calls
    .filter(([method]) => method === 'Runtime.callFunctionOn')
    .map(([, params]) => declaration(params));
}

async function clickFailure(click: Promise<void>): Promise<ElementResolutionError> {
  try {
    await click;
  } catch (error) {
    if (error instanceof ElementResolutionError) return error;
    throw error;
  }
  throw new Error('the click did not fail');
}

test('Page click validates a top-level target once before the move and once before the press', async () => {
  const { calls, services } = topLevelClickServices();

  await clickInPage(services, 'session:page', new RefMap(), '#button');

  expect(actionSequence(calls)).toEqual([
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mouseMoved',
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
    'Runtime.releaseObject',
  ]);
  const [pointCheck = '', pressCheck = ''] = pageCalls(calls);
  for (const check of [pointCheck, pressCheck]) {
    expect(check, 'each page call verifies the enabled state').toMatch(
      /isActionTargetDisabled\(this\)/,
    );
    expect(check, 'each page call verifies the hit target').toMatch(
      /interceptingElementAtPoint\(this, point\)/,
    );
  }
  expect(pointCheck).toMatch(/setTimeout\(finish, 100\)/);
  expect(pressCheck, 'the pre-press recheck does not wait for layout again').not.toMatch(
    /setTimeout\(finish, 100\)/,
  );
  const pressEvents = calls.filter(
    ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type !== 'mouseMoved',
  );
  expect(
    pressEvents.every(([, params]) => params.x === 10 && params.y === 20),
    'press and release use the resolved action point',
  ).toBe(true);
});

test('Page click fails before any pointer input when the element is disabled', async () => {
  const { calls, services } = topLevelClickServices({
    point: { error: 'element is disabled' },
  });

  const error = await clickFailure(clickInPage(services, 'session:page', new RefMap(), '#button'));
  expect(error.name).toBe('ElementResolutionError');
  expect(error.kind).toBe('transient');
  expect(error.message).toBe('page.click failed: element is disabled');
  expect(calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false);
});

test('Page click fails closed when the pre-press recheck reports an interceptor', async () => {
  const { calls, services } = topLevelClickServices({
    respond: () => ({
      error: '<div id="hover-overlay"> intercepts pointer events',
    }),
  });

  const error = await clickFailure(clickInPage(services, 'session:page', new RefMap(), '#button'));
  expect(error.name).toBe('ElementResolutionError');
  expect(error.kind).toBe('transient');
  expect(error.message).toBe(
    'page.click failed: <div id="hover-overlay"> intercepts pointer events',
  );
  expect(actionSequence(calls), 'the pointer moved but no press reached the page').toEqual([
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mouseMoved',
    'Runtime.callFunctionOn',
    'Runtime.releaseObject',
  ]);
});

test('Page click force skips the hit test but still rejects a disabled element', async () => {
  const { calls, services } = topLevelClickServices();

  await clickInPage(services, 'session:page', new RefMap(), '#button', {
    force: true,
  });

  for (const check of pageCalls(calls)) {
    expect(check).toMatch(/isActionTargetDisabled\(this\)/);
    expect(check).not.toMatch(/elementsFromPoint/);
  }
  expect(
    calls.filter(
      ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed',
    ),
  ).toHaveLength(1);
});

test('Page click rechecks the target before every press of a multi-click', async () => {
  const { calls, services } = topLevelClickServices();

  await clickInPage(services, 'session:page', new RefMap(), '#button', {
    clickCount: 2,
  });

  expect(actionSequence(calls)).toEqual([
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mouseMoved',
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
    'Runtime.releaseObject',
  ]);
  const presses = calls
    .filter(
      ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed',
    )
    .map(([, params]) => params.clickCount);
  expect(presses).toEqual([1, 2]);
});

test('Page click translates same-process iframe coordinates to the Page viewport', async () => {
  const calls: Call[] = [];
  const states: string[] = [];
  const services = quietServices(
    calls,
    (method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return params.frameId === 'frame-child'
          ? {
              nodes: [
                {
                  role: { value: 'button' },
                  name: { value: 'Run iframe action' },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'iframe-button' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (declaration(params).includes('actionable: false')) {
          return { result: { value: { actionable: true } } };
        }
        return declaration(params).includes('getBoundingClientRect')
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === 'DOM.getFrameOwner') {
        return { backendNodeId: 90 };
      }
      if (method === 'DOM.getBoxModel') {
        const callCount = calls.filter(
          ([calledMethod]) => calledMethod === 'DOM.getBoxModel',
        ).length;
        const y = callCount === 1 ? 200 : 219;
        return {
          model: { content: [100, y, 300, y, 300, y + 200, 100, y + 200] },
        };
      }
      return {};
    },
    {
      showAgentTaskState(state) {
        states.push(state);
        return Promise.resolve();
      },
    },
  );

  await clickInPage(
    services,
    'session:page',
    new RefMap(),
    'loc=role:button[name="Run iframe action"]',
    {},
    0,
    new Map([['frame-child', 'session:page']]),
  );

  const pointerEvents = calls
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params]) => params);
  expect(pointerEvents).toHaveLength(4);
  expect(
    pointerEvents[0]?.x === 110 && pointerEvents[0].y === 220,
    'the initial move uses the first top-level Page coordinates',
  ).toBe(true);
  expect(
    pointerEvents.slice(1).every(({ x, y }) => x === 110 && y === 239),
    'the press uses coordinates translated again after the pointer move',
  ).toBe(true);
  const hitTest = calls.find(
    ([method, params]) =>
      method === 'Runtime.callFunctionOn' && declaration(params).includes('isConnected'),
  );
  expect(
    declaration(hitTest?.[1] ?? {}),
    'the iframe-local actionability check uses its own document',
  ).toMatch(/elementsFromPoint\(point\.x, point\.y\)/);
  const moveIndex = calls.findLastIndex(
    ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved',
  );
  const initialMoveIndex = calls.findIndex(
    ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved',
  );
  const pressIndex = calls.findIndex(
    ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed',
  );
  expect(
    calls
      .slice(initialMoveIndex + 1, moveIndex)
      .some(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' && declaration(params).includes('elementsFromPoint'),
      ),
    'iframe clicks recheck the frame-local hit target after the initial pointer move',
  ).toBe(true);
  expect(
    calls.slice(moveIndex + 1, pressIndex).some(([method]) => method === 'Runtime.callFunctionOn'),
    'same-process iframe input keeps mouseMoved and mousePressed contiguous',
  ).toBe(false);
  expect(states).toEqual(['Clicking element']);
});

test('Page click keeps raw-selector OOPIF input local but renders its cursor in the Page viewport', async () => {
  const calls: Call[] = [];
  const cursorPoints: { x: number; y: number }[] = [];
  const services = quietServices(
    calls,
    (method, params, sessionId) => {
      if (method === 'Accessibility.getFullAXTree') {
        return sessionId === 'session:frame'
          ? {
              nodes: [
                {
                  role: { value: 'button' },
                  name: { value: 'Run OOPIF action' },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === 'Runtime.evaluate') {
        if (params.returnByValue === false) {
          return sessionId === 'session:frame'
            ? { result: { objectId: 'iframe-button' } }
            : { result: {} };
        }
        return {
          result: {
            value: sessionId === 'session:frame' ? 1 : 0,
          },
        };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'iframe-button' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (declaration(params).includes('actionable: false')) {
          return { result: { value: { actionable: true } } };
        }
        return declaration(params).includes('getBoundingClientRect')
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'frame-page' },
            childFrames: [{ frame: { id: 'frame-child' } }],
          },
        };
      }
      if (method === 'DOM.getFrameOwner') {
        expect(sessionId).toBe('session:page');
        expect(params.frameId).toBe('frame-child');
        return { backendNodeId: 90 };
      }
      if (method === 'DOM.getBoxModel') {
        expect(sessionId).toBe('session:page');
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    {
      showAgentMousePosition(x, y) {
        cursorPoints.push({ x, y });
        return Promise.resolve();
      },
    },
  );

  await clickInPage(
    services,
    'session:page',
    new RefMap(),
    '#iframe-button',
    {},
    0,
    new Map([['frame-child', 'session:frame']]),
  );

  const pointerEvents = calls
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params, sessionId]) => ({ params, sessionId }));
  expect(
    pointerEvents.every(
      ({ params, sessionId }) =>
        sessionId === 'session:frame' && params.x === 10 && params.y === 20,
    ),
    "OOPIF input stays in the child target's local viewport",
  ).toBe(true);
  expect(cursorPoints).toEqual([{ x: 110, y: 220 }]);
});

test('Page click renders an OOPIF cursor when FrameTree omits its ancestor iframe', async () => {
  const calls: Call[] = [];
  const cursorPoints: { x: number; y: number }[] = [];
  const services = quietServices(
    calls,
    (method, params, sessionId) => {
      if (method === 'Accessibility.getFullAXTree') {
        return sessionId === 'session:map'
          ? {
              nodes: [
                {
                  role: { value: 'button' },
                  name: { value: 'Run nested OOPIF action' },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'iframe-button' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (declaration(params).includes('actionable: false')) {
          return { result: { value: { actionable: true } } };
        }
        return declaration(params).includes('getBoundingClientRect')
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'frame-page' },
          },
        };
      }
      if (method === 'DOM.getFrameOwner') {
        if (params.frameId === 'frame-map') {
          expect(sessionId).toBe('session:runner');
          return { backendNodeId: 90 };
        }
        if (params.frameId === 'frame-demo') {
          expect(sessionId).toBe('session:page');
          return { backendNodeId: 91 };
        }
        throw new Error(`unexpected frame owner ${String(params.frameId)}`);
      }
      if (method === 'DOM.getBoxModel') {
        const [x, y] = params.backendNodeId === 90 ? [100, 200] : [300, 400];
        return {
          model: { content: [x, y, x + 200, y, x + 200, y + 200, x, y + 200] },
        };
      }
      return {};
    },
    {
      showAgentMousePosition(x, y) {
        cursorPoints.push({ x, y });
        return Promise.resolve();
      },
    },
  );

  const iframeSessions: FrameSessions = Object.assign(
    new Map([
      ['frame-demo', 'session:runner'],
      ['frame-map', 'session:map'],
    ]),
    {
      parentFrameIds: new Map([
        ['frame-demo', 'frame-page'],
        ['frame-map', 'frame-demo'],
      ]),
    },
  );

  await clickInPage(
    services,
    'session:page',
    new RefMap(),
    'loc=role:button[name="Run nested OOPIF action"]',
    {},
    0,
    iframeSessions,
  );

  const pointerEvents = calls
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params, sessionId]) => ({ params, sessionId }));
  expect(
    pointerEvents.every(
      ({ params, sessionId }) => sessionId === 'session:map' && params.x === 10 && params.y === 20,
    ),
    "OOPIF input stays in the child target's local viewport",
  ).toBe(true);
  expect(cursorPoints).toEqual([{ x: 410, y: 620 }]);
});
