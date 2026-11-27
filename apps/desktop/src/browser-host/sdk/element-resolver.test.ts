// Ported from ego-browser package/ego-browser/src/element-resolver.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest. resolveElementCenter is dropped with the v1 helpers,
// so its three box-model tests are dropped and the locator tests that went through it now run the
// same selectors through resolveElementObjectId (the count and find expressions carry the same
// locator code, and the result is the resolved object instead of a point).

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import type { CdpCall, CdpObject } from './cdp-types.js';
import { ElementResolutionError, resolveElementObjectId } from './element-resolver.js';
import { PageRefRegistry } from './page-ref-registry.js';
import { RefMap } from './ref-map.js';

type Handler = (method: string, params: CdpObject, sessionId: string | undefined) => unknown;

class FakeCDP {
  readonly calls: [string, CdpObject, string | undefined][] = [];
  readonly sendRaw: CdpCall;

  constructor(handler: Handler) {
    this.sendRaw = fakeCdp((method, params, sessionId) => {
      this.calls.push([method, params, sessionId]);
      return handler(method, params, sessionId);
    });
  }
}

/** The `expression` (or another string field) of a CDP call's params. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Awaits a rejection and answers it as the resolver's error. */
async function resolutionError(promise: Promise<unknown>): Promise<ElementResolutionError> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ElementResolutionError);
  if (!(failure instanceof ElementResolutionError)) throw new Error('expected a rejection');
  return failure;
}

/** Answers a locator's count with 1 and its find with `objectId`, after checking `check`. */
function uniqueLocator(objectId: string, check: (expression: string) => void): Handler {
  return (method, params) => {
    if (method === 'Runtime.evaluate') {
      check(text(params.expression));
      return params.returnByValue ? { result: { value: 1 } } : { result: { objectId } };
    }
    return {};
  };
}

test('resolveElementObjectId: Page refs never fall back to a different node with the same label', async () => {
  const refs = new PageRefRegistry().replace('page', [
    { refId: 1, backendNodeId: 100, role: 'button', name: 'Save' },
  ]);
  const cdp = new FakeCDP((method, params) => {
    if (params.backendNodeId === 100) throw new Error('No node with given id found');
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Save' },
            backendDOMNodeId: 200,
          },
        ],
      };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'replacement-save-button' } };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    return {};
  });

  await expect(resolveElementObjectId(cdp, 'session:page', refs, '@1')).rejects.toThrow(
    /Stale ref: @1/,
  );
  expect(cdp.calls.some(([method]) => method === 'Accessibility.getFullAXTree')).toBe(false);
});

const AX_TREE = {
  nodes: [{ role: { value: 'button' }, name: { value: 'ok' }, backendDOMNodeId: 100 }],
};

test('exact Page refs preserve session errors for the existing recovery boundary', async () => {
  const refs = new PageRefRegistry().replace('page', [
    { refId: 1, backendNodeId: 100, frameId: 'frame' },
  ]);
  const failure = Object.assign(new Error('Session with given id not found'), {
    sessionId: 'session:frame',
  });
  const cdp = new FakeCDP(() => {
    throw failure;
  });
  let thrown: unknown;
  try {
    await resolveElementObjectId(
      cdp,
      'session:page',
      refs,
      '@1',
      new Map([['frame', 'session:frame']]),
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(failure);
});

test('Page refs with unknown frame provenance fail before resolving an ambiguous backend id', async () => {
  const refs = new PageRefRegistry().replace('page', [
    { refId: 1, backendNodeId: 100, frameProvenance: 'unknown' },
  ]);
  const cdp = new FakeCDP(() => ({
    object: { objectId: 'unverified-node' },
  }));
  await expect(resolveElementObjectId(cdp, 'session:page', refs, '@1')).rejects.toThrow(
    /unknown frame provenance/,
  );
  expect(cdp.calls).toHaveLength(0);
});

test('stale backend node still falls back to role/name lookup', async () => {
  const refMap = new RefMap();
  refMap.add('5', 100, 'button', 'ok');
  let resolveCalls = 0;
  const cdp = new FakeCDP((method) => {
    if (method === 'DOM.resolveNode') {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        throw new Error('No node with given id found');
      }
      return { object: { objectId: 'ok-button' } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return AX_TREE;
    }
    return {};
  });
  const resolved = await resolveElementObjectId(cdp, 'session:page', refMap, '@5');
  expect(resolved).toEqual({ objectId: 'ok-button', sessionId: 'session:page' });
  expect(
    cdp.calls.some(([method]) => method === 'Accessibility.getFullAXTree'),
    'a stale node must trigger the role/name fallback',
  ).toBe(true);
});

test('iframe refs recover frame provenance before resolving a colliding backend node', async () => {
  const refMap = new RefMap();
  refMap.addWithFrame('4729', 21, 'option', 'Upload', undefined, undefined, 'unknown');
  const cdp = new FakeCDP((method, params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      if (sessionId === 'session:picker') {
        return {
          nodes: [
            {
              role: { value: 'option' },
              name: { value: 'Upload' },
              backendDOMNodeId: 21,
            },
          ],
        };
      }
      if (sessionId === 'session:page' && !params.frameId) {
        return {
          nodes: [
            {
              role: { value: 'button' },
              name: { value: 'Close' },
              backendDOMNodeId: 21,
            },
          ],
        };
      }
      return { nodes: [] };
    }
    if (method === 'DOM.resolveNode') {
      return {
        object: {
          objectId: sessionId === 'session:picker' ? 'picker-upload-option' : 'wrong-page-node',
        },
      };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    refMap,
    '@4729',
    new Map([
      ['frame:picker', 'session:picker'],
      ['frame:other', 'session:other'],
    ]),
  );

  expect(resolved).toEqual({
    objectId: 'picker-upload-option',
    sessionId: 'session:picker',
    frameId: 'frame:picker',
  });
});

test('main-page ref provenance skips frame recovery', async () => {
  const refMap = new RefMap();
  refMap.addWithFrame('73', 100, 'button', 'Save', undefined, undefined, 'page');
  const cdp = new FakeCDP((method, _params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      throw new Error('main-page refs must not scan frame AX trees');
    }
    if (method === 'DOM.resolveNode') {
      expect(sessionId).toBe('session:page');
      return { object: { objectId: 'page-save-button' } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      refMap,
      '@73',
      new Map([['frame:detached', 'session:detached']]),
    ),
  ).toEqual({ objectId: 'page-save-button', sessionId: 'session:page' });
});

test('unknown frame provenance recovers by backend id after the accessible name changes', async () => {
  const refMap = new RefMap();
  refMap.addWithFrame('73', 100, 'button', 'Save', undefined, undefined, 'unknown');
  const cdp = new FakeCDP((method, _params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return sessionId === 'session:frame'
        ? {
            nodes: [
              {
                role: { value: 'button' },
                name: { value: 'Saving…' },
                backendDOMNodeId: 100,
              },
            ],
          }
        : { nodes: [] };
    }
    if (method === 'DOM.resolveNode') {
      expect(sessionId).toBe('session:frame');
      return { object: { objectId: 'frame-save-button' } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      refMap,
      '@73',
      new Map([['frame:child', 'session:frame']]),
    ),
  ).toEqual({
    objectId: 'frame-save-button',
    sessionId: 'session:frame',
    frameId: 'frame:child',
  });
});

test('unknown frame provenance falls back to the main document when no frame owns the node', async () => {
  const refMap = new RefMap();
  refMap.addWithFrame('74', 100, 'button', 'Save', undefined, undefined, 'unknown');
  const cdp = new FakeCDP((method, _params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return sessionId === 'session:page'
        ? {
            nodes: [
              {
                role: { value: 'button' },
                name: { value: 'Save' },
                backendDOMNodeId: 100,
              },
            ],
          }
        : { nodes: [] };
    }
    if (method === 'DOM.resolveNode') {
      expect(sessionId).toBe('session:page');
      return { object: { objectId: 'page-save-button' } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      refMap,
      '@74',
      new Map([['frame:child', 'session:frame']]),
    ),
  ).toEqual({ objectId: 'page-save-button', sessionId: 'session:page' });
});

test('CSS locators search nested open shadow roots', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('shadow-field', (expression) => {
      expect(
        expression,
        'the CSS query must visit open shadow roots instead of using only document.querySelectorAll',
      ).toMatch(/shadowRoot/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'loc=css:input[aria-label="Shadow field"]',
  );

  expect(resolved).toEqual({ objectId: 'shadow-field', sessionId: 'session:page' });
});

test('Playwright css= aliases the documented CSS locator', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('target', (expression) => {
      expect(expression).toMatch(/button#target/);
      expect(expression).not.toMatch(/__egoQueryAllOpenShadow\("css=button/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'css=button#target',
  );

  expect(resolved).toEqual({ objectId: 'target', sessionId: 'session:page' });
});

test('Playwright has-text and text-is pseudos keep their matching semantics', async () => {
  const expressions: string[] = [];
  const cdp = new FakeCDP(
    uniqueLocator('save', (expression) => {
      expressions.push(expression);
    }),
  );

  await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'button:has-text("Save changes")',
  );
  const firstResolution = expressions.splice(0);
  await resolveElementObjectId(cdp, 'session:page', new RefMap(), "loc=css:button:text-is('Save')");

  expect(firstResolution.length).toBeGreaterThan(0);
  expect(expressions.length).toBeGreaterThan(0);
  for (const expression of firstResolution) {
    expect(expression).toMatch(/selector: "button"/);
    expect(expression).toMatch(/mode: "substring"/);
    expect(expression).toMatch(/toLowerCase\(\)\.includes/);
  }
  for (const expression of expressions) {
    expect(expression).toMatch(/mode: "exact"/);
    expect(expression).toMatch(/immediate\.some/);
  }
});

test('Playwright text pseudos strictly decode quoted CSS strings', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('cant', (expression) => {
      expect(expression).toMatch(/can&apos;t|can't/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    String.raw`button:text-is('can\'t')`,
  );

  expect(resolved).toEqual({ objectId: 'cant', sessionId: 'session:page' });
});

test('Playwright text pseudos decode CSS hex escapes and their terminator', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('ab', (expression) => {
      expect(expression).toMatch(/text: "AB"/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    String.raw`button:text-is("\41 B")`,
  );

  expect(resolved).toEqual({ objectId: 'ab', sessionId: 'session:page' });
});

test('Playwright text-is matches an element with no immediate text', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('empty', (expression) => {
      expect(expression).toMatch(/expected === ""/);
      expect(expression).toMatch(/text\.immediate\.length === 0/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    '#empty:text-is("")',
  );

  expect(resolved).toEqual({ objectId: 'empty', sessionId: 'session:page' });
});

test('raw CSS may contain compatibility tokens inside quoted values', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expression = text(params.expression);
      expect(expression).toMatch(/data-value/);
      expect(expression).toMatch(/:has-text/);
      return { result: { objectId: 'data-value' } };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    '[data-value=":has-text("]',
  );

  expect(resolved).toEqual({ objectId: 'data-value', sessionId: 'session:page' });
});

test('Playwright terminal nth selects before actionability filtering', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('second', (expression) => {
      expect(expression).toMatch(/const values = Array\.from/);
      expect(expression).toMatch(/const index = 1/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    '.duplicate >> nth=1',
  );

  expect(resolved).toEqual({ objectId: 'second', sessionId: 'session:page' });
});

test('Playwright text filters compose with nth=-1 and quoted parentheses', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('last-draft', (expression) => {
      expect(expression).toMatch(/Save \(draft\)/);
      expect(expression).toMatch(/const index = -1 === -1/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'button:has-text("Save (draft)") >> nth=-1',
  );

  expect(resolved).toEqual({ objectId: 'last-draft', sessionId: 'session:page' });
});

test('unsupported Playwright selector combinations fail before CDP', async () => {
  const cdp = new FakeCDP(() => {
    throw new Error('unsupported selector syntax must not reach CDP');
  });

  for (const selector of [
    'button:has-text(Save)',
    'button:has-text("a" "b")',
    'button, a:has-text("Docs")',
    'loc=css:button:not(:has-text("Save"))',
    '.row >> visible=true',
  ]) {
    const error = await resolutionError(
      resolveElementObjectId(cdp, 'session:page', new RefMap(), selector, new Map(), {
        strict: true,
      }),
    );
    expect(error.kind).toBe('permanent');
    expect(error.message).toMatch(/Invalid locator/);
  }
  expect(cdp.calls).toEqual([]);
});

test('role name*= uses a case-insensitive accessible-name substring', async () => {
  const cdp = new FakeCDP((method) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Increment counter 42' },
            backendDOMNodeId: 101,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'increment' } };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'loc=role:button[name*="increment COUNTER"]',
  );

  expect(resolved).toEqual({ objectId: 'increment', sessionId: 'session:page' });
});

test('invalid numeric CSS ids suggest a valid attribute selector', async () => {
  const cdp = new FakeCDP((method) => {
    if (method === 'Runtime.evaluate') {
      return {
        exceptionDetails: {
          exception: {
            description: "SyntaxError: Failed to execute 'querySelectorAll' on 'Document'",
          },
        },
      };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      '#73503e10-2be7-42d1-a053-c77402da1f80',
      new Map(),
      { strict: true },
    ),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/\[id="73503e10-2be7-42d1-a053-c77402da1f80"\]/);
});

test('malformed role locators fail before raw CSS evaluation', async () => {
  const cdp = new FakeCDP(() => {
    throw new Error('malformed role locator must not reach CDP');
  });

  const error = await resolutionError(
    resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:button[name^="View flight details"]',
      new Map(),
      { strict: true },
    ),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/loc=role:<role>\[name="<exact name>"\]/);
  expect(error.message).toMatch(/text=\.\.\./);
  expect(cdp.calls).toEqual([]);
});

test('text locators normalize whitespace and search nested open shadow roots', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('save-changes', (expression) => {
      expect(expression).toMatch(/shadowRoot/);
      expect(expression).toMatch(/replace\(\/\\s\+\/g, " "\)/);
      expect(expression).toMatch(/toLowerCase\(\)\s*\.includes/);
      expect(expression).toMatch(/INPUT/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'text=Save changes',
  );

  expect(resolved).toEqual({ objectId: 'save-changes', sessionId: 'session:page' });
});

test('quoted text locators use exact case-sensitive matching', async () => {
  const cdp = new FakeCDP(
    uniqueLocator('exact-save', (expression) => {
      expect(expression).toMatch(/mode: "exact"/);
      expect(expression).toMatch(/=== expected/);
    }),
  );

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'text="Save changes"',
  );

  expect(resolved).toEqual({ objectId: 'exact-save', sessionId: 'session:page' });
});

test('ambiguous text locators fail permanently instead of choosing one match', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method === 'Runtime.evaluate') {
      if (text(params.expression).includes('__egoDescribeMatches')) {
        return {
          result: {
            value: {
              visible: 2,
              hidden: 0,
              candidates: [
                { tag: 'button', name: 'Save draft', visible: true },
                { tag: 'button', name: 'Save changes', visible: true },
              ],
            },
          },
        };
      }
      return { result: { value: 2 } };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(cdp, 'session:page', new RefMap(), 'text=Save'),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/matched 2 elements/);
  expect(error.message).toMatch(/2 visible, 0 hidden/);
  expect(error.message).toMatch(/button "Save draft"/);
  expect(error.message).toMatch(/current snapshot ref|more specific/i);
});

test('ambiguous raw CSS selectors fail instead of choosing the first match', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expression = text(params.expression);
      if (expression.includes('__egoDescribeMatches')) {
        return {
          result: {
            value: {
              visible: 2,
              hidden: 1,
              candidates: [
                {
                  tag: 'button',
                  role: 'button',
                  name: 'Create',
                  visible: true,
                  disabled: false,
                },
                {
                  tag: 'button',
                  role: 'button',
                  name: 'Create menu',
                  visible: true,
                  disabled: false,
                },
                {
                  tag: 'button',
                  name: 'Create',
                  visible: false,
                  disabled: true,
                },
              ],
            },
          },
        };
      }
      expect(expression).toMatch(/querySelectorAll/);
      return { result: { value: 3 } };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(cdp, 'session:page', new RefMap(), 'button.save', new Map(), {
      strict: true,
    }),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/Selector button\.save matched 3 elements/);
  expect(error.message).toMatch(/2 visible, 1 hidden/);
  expect(error.message).toMatch(/button role=button "Create" \(visible\)/);
  expect(error.message).toMatch(/button "Create" \(hidden, disabled\)/);
  expect(error.message).toMatch(/current snapshot ref|more specific/i);
});

test('action resolution uses the sole usable CSS match', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    if (text(params.expression).includes('__egoActionableMatches')) {
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: 'visible-button' } };
    }
    return { result: { value: 2 } };
  });

  expect(
    await resolveElementObjectId(cdp, 'session:page', new RefMap(), 'button.save', new Map(), {
      strict: true,
      actionability: 'enabled',
    }),
  ).toEqual({ objectId: 'visible-button', sessionId: 'session:page' });
});

test('action resolution prefers a sole actionable Page match over iframe matches', async () => {
  const cdp = new FakeCDP((method, params, sessionId) => {
    if (method !== 'Runtime.evaluate') return {};
    if (text(params.expression).includes('__egoActionableMatches')) {
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: `button:${String(sessionId)}` } };
    }
    return { result: { value: 1 } };
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'button.save',
      new Map([['frame-child', 'session:frame-child']]),
      { strict: true, actionability: 'pointer-enabled' },
    ),
  ).toEqual({ objectId: 'button:session:page', sessionId: 'session:page' });
});

test('pointer action resolution skips a covered Page match for a frame match', async () => {
  const cdp = new FakeCDP((method, params, sessionId) => {
    if (method !== 'Runtime.evaluate') return {};
    const expression = text(params.expression);
    if (expression.includes('__egoActionableMatches')) {
      expect(expression).toMatch(/elementsFromPoint/);
      if (params.returnByValue) {
        return {
          result: { value: sessionId === 'session:frame-child' ? 1 : 0 },
        };
      }
      return { result: { objectId: 'frame-button' } };
    }
    return { result: { value: 1 } };
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'button.move',
      new Map([['frame-child', 'session:frame-child']]),
      { strict: true, actionability: 'pointer-enabled' },
    ),
  ).toEqual({
    objectId: 'frame-button',
    sessionId: 'session:frame-child',
    frameId: 'frame-child',
  });
});

test('enabled action resolution permits opacity-zero native controls', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    const expression = text(params.expression);
    if (expression.includes('__egoActionableMatches')) {
      expect(expression).not.toMatch(/style\.opacity/);
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: 'transparent-select' } };
    }
    return { result: { value: 1 } };
  });

  expect(
    await resolveElementObjectId(cdp, 'session:page', new RefMap(), 'select.sort', new Map(), {
      strict: true,
      actionability: 'enabled',
    }),
  ).toEqual({ objectId: 'transparent-select', sessionId: 'session:page' });
});

test('action resolution reports hidden and zero-sized blockers', async () => {
  for (const blocker of ['element is hidden or inert', 'element has a zero-sized bounding box']) {
    const cdp = new FakeCDP((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = text(params.expression);
      if (expression.includes('for (const element')) {
        expect(expression).toMatch(/element is hidden or inert/);
        expect(expression).toMatch(/element has a zero-sized bounding box/);
        return { result: { value: blocker } };
      }
      if (expression.includes('__egoActionableMatches')) {
        return { result: { value: 0 } };
      }
      return { result: { value: 1 } };
    });

    const error = await resolutionError(
      resolveElementObjectId(cdp, 'session:page', new RefMap(), 'button.save', new Map(), {
        strict: true,
        actionability: 'pointer-enabled',
      }),
    );
    expect(error.kind).toBe('transient');
    expect(error.message).toMatch(new RegExp(blocker));
  }
});

test('role action resolution reports visibility blockers', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Hidden' },
            backendDOMNodeId: 101,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'hidden-button' } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const declaration = text(params.functionDeclaration);
      expect(declaration).toMatch(/element is hidden or inert/);
      expect(declaration).toMatch(/element has a zero-sized bounding box/);
      return {
        result: {
          value: { actionable: false, blocker: 'element is hidden or inert' },
        },
      };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:button[name="Hidden"]',
      new Map(),
      { actionability: 'pointer-enabled' },
    ),
  );
  expect(error.kind).toBe('transient');
  expect(error.message).toMatch(/element is hidden or inert/);
});

test('ambiguous raw XPath selectors fail instead of choosing the first match', async () => {
  const cdp = new FakeCDP((method, params) => {
    if (method === 'Runtime.evaluate') {
      expect(text(params.expression)).toMatch(/ORDERED_NODE_SNAPSHOT_TYPE/);
      return { result: { value: 2 } };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(cdp, 'session:page', new RefMap(), 'xpath=//button', new Map(), {
      strict: true,
    }),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/Selector xpath=\/\/button matched 2 elements/);
});

test('semantic locators search cross-process iframe sessions', async () => {
  const cdp = new FakeCDP((method, params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return sessionId === 'session:frame-child'
        ? {
            nodes: [
              {
                role: { value: 'button' },
                name: { value: 'Run iframe action' },
                backendDOMNodeId: 201,
              },
            ],
          }
        : { nodes: [] };
    }
    if (method === 'DOM.resolveNode') {
      expect(sessionId).toBe('session:frame-child');
      expect(params.backendNodeId).toBe(201);
      return { object: { objectId: 'iframe-button' } };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(
    cdp,
    'session:page',
    new RefMap(),
    'loc=role:button[name="Run iframe action"]',
    new Map([['frame-child', 'session:frame-child']]),
  );

  expect(resolved).toEqual({
    objectId: 'iframe-button',
    sessionId: 'session:frame-child',
    frameId: 'frame-child',
  });
});

test('text locators search same-process iframe execution contexts', async () => {
  const cdp = new FakeCDP((method, params, sessionId) => {
    expect(sessionId).toBe('session:page');
    if (method === 'Page.createIsolatedWorld') {
      expect(params.frameId).toBe('frame-child');
      return { executionContextId: 77 };
    }
    if (method === 'Runtime.evaluate') {
      const inFrame = params.contextId === 77;
      if (params.returnByValue) {
        return { result: { value: inFrame ? 1 : 0 } };
      }
      return {
        result: inFrame ? { objectId: 'same-process-upload' } : { type: 'undefined' },
      };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'text="Upload"',
      new Map([['frame-child', 'session:page']]),
      { strict: true },
    ),
  ).toEqual({
    objectId: 'same-process-upload',
    sessionId: 'session:page',
    frameId: 'frame-child',
  });
});

test('snapshot role aliases resolve against standard accessibility roles', async () => {
  const cdp = new FakeCDP((method) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'option' },
            name: { value: 'Upload' },
            backendDOMNodeId: 201,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'upload-option' } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:listboxoption[name="Upload"]',
    ),
  ).toEqual({ objectId: 'upload-option', sessionId: 'session:page' });
});

test('same-process frame role matches keep their frame provenance', async () => {
  const cdp = new FakeCDP((method) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'option' },
            name: { value: 'Upload' },
            backendDOMNodeId: 201,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'upload-option' } };
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { actionable: true } } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:listboxoption[name="Upload"]',
      new Map([['frame-child', 'session:page']]),
      { actionability: 'pointer-enabled' },
    ),
  ).toEqual({
    objectId: 'upload-option',
    sessionId: 'session:page',
    frameId: 'frame-child',
  });
});

test('a unique interactable frame role wins over a blocked Page duplicate', async () => {
  const cdp = new FakeCDP((method, params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Duplicate' },
            backendDOMNodeId: sessionId === 'session:page' ? 1 : 2,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: `node:${String(sessionId)}` } };
    }
    if (method === 'Runtime.callFunctionOn') {
      expect(text(params.functionDeclaration)).toMatch(/elementsFromPoint/);
      return { result: { value: sessionId === 'session:frame-child' } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:button[name="Duplicate"]',
      new Map([['frame-child', 'session:frame-child']]),
      { actionability: 'pointer-enabled' },
    ),
  ).toEqual({
    objectId: 'node:session:frame-child',
    sessionId: 'session:frame-child',
    frameId: 'frame-child',
  });
});

test('role actions prefer the actionable Page match over a frame match', async () => {
  const cdp = new FakeCDP((method, _params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Duplicate' },
            backendDOMNodeId: sessionId === 'session:page' ? 1 : 2,
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: `node:${String(sessionId)}` } };
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: true } };
    }
    return {};
  });

  expect(
    await resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:button[name="Duplicate"]',
      new Map([['frame-child', 'session:frame-child']]),
      { actionability: 'pointer-enabled' },
    ),
  ).toEqual({ objectId: 'node:session:page', sessionId: 'session:page' });
});

test('strict global role validation rejects a hidden duplicate', async () => {
  const cdp = new FakeCDP((method, _params, sessionId) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'textbox' },
            name: { value: 'Prompt' },
            backendDOMNodeId: sessionId === 'session:page' ? 1 : 2,
          },
        ],
      };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(
      cdp,
      'session:page',
      new RefMap(),
      'loc=role:textbox[name="Prompt"]',
      new Map([['frame-child', 'session:frame-child']]),
      { strictGlobal: true },
    ),
  );
  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/matched 2 elements/);
});

test('a stale ref refuses an ambiguous role/name recovery', async () => {
  // The ref points at a row that left the DOM. Role and name are all that is
  // left to identify it, and they no longer single one element out, so the
  // recovery must fail instead of acting on whichever row comes first.
  const refMap = new RefMap();
  refMap.add('23', 13, 'button', 'Delete');
  const cdp = new FakeCDP((method, params) => {
    if (method === 'DOM.resolveNode') {
      if (params.backendNodeId === 13) {
        throw new Error('Could not find node with given id');
      }
      return { object: { objectId: `obj-${String(params.backendNodeId)}` } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Delete' },
            backendDOMNodeId: 11,
          },
          {
            role: { value: 'button' },
            name: { value: 'Delete' },
            backendDOMNodeId: 12,
          },
        ],
      };
    }
    return {};
  });

  const error = await resolutionError(
    resolveElementObjectId(cdp, 'session:page', refMap, '@23', new Map(), { strict: true }),
  );

  expect(error.kind).toBe('permanent');
  expect(error.message).toMatch(/matched 2 elements/);
  expect(
    cdp.calls.some(
      ([method, params]) => method === 'DOM.resolveNode' && params.backendNodeId !== 13,
    ),
    'an ambiguous recovery must not resolve some other node',
  ).toBe(false);
});

test('a stale ref still recovers when role and name identify one element', async () => {
  // The legitimate case the fallback exists for: a re-render replaced the node
  // but exactly one element still carries that role and name.
  const refMap = new RefMap();
  refMap.add('23', 13, 'button', 'Save');
  const cdp = new FakeCDP((method, params) => {
    if (method === 'DOM.resolveNode') {
      if (params.backendNodeId === 13) {
        throw new Error('Could not find node with given id');
      }
      return { object: { objectId: `obj-${String(params.backendNodeId)}` } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Save' },
            backendDOMNodeId: 99,
          },
        ],
      };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(cdp, 'session:page', refMap, '@23', new Map(), {
    strict: true,
  });
  expect(resolved.objectId).toBe('obj-99');
});
