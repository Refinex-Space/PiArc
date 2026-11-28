// Ported from ego-browser package/ego-browser/src/snapshot-result.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; CDP fakes go through `fakeCdp`.

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import type { CdpObject } from './cdp-types.js';
import {
  compactSnapshotContent,
  compactSnapshotResult,
  preparePageSnapshotResult,
  rewriteSnapshotRefIds,
  sanitizeSnapshotLocators,
  validateSnapshotLocator,
  type SnapshotRef,
  type SnapshotResult,
} from './snapshot-result.js';

function objectSuffix(params: CdpObject, prefix: string): string {
  return String(params.objectId).slice(prefix.length);
}

function refsOf(result: SnapshotResult): readonly SnapshotRef[] {
  return result.refs ?? [];
}

test('public ref rewriting changes metadata once without changing quoted content or locators', () => {
  const input = [
    'button "literal \\"[ref=1]\\"" [ref=1, loc=css:[data-ref="[ref=1]"]]',
    '  button "Second" [ref=2]',
    '  text "keep [ref=1]"',
    'button [ref=99]',
    '',
  ].join('\r\n');
  expect(
    rewriteSnapshotRefIds(
      input,
      new Map([
        ['1', '2'],
        ['2', '3'],
      ]),
    ),
  ).toBe(
    [
      'button "literal \\"[ref=1]\\"" [ref=2, loc=css:[data-ref="[ref=1]"]]',
      '  button "Second" [ref=3]',
      '  text "keep [ref=1]"',
      'button [ref=99]',
      '',
    ].join('\r\n'),
  );
});

test('snapshot compaction removes only redundant text and containers', () => {
  const content = [
    'root',
    '  container',
    '  container',
    '    container',
    '      button [ref=1, loc=unstable]',
    '        text "Save"',
    '  container',
    '    text "A"',
    '    text "B"',
    '  text',
    '  text " "',
    '  text "​"',
    '  container "Section"',
    '    text "Title"',
    '  container [ref=2, loc=ambiguous]',
    '  button [ref=3, loc=css:#confirm]',
    '  button [ref=5, loc=css:[loc=unstable]]',
    '  anchor [ref=6, loc=unstable, url=https://example.com/item]',
    '  text "literal [ref=9, loc=unstable]"',
    '  image',
    '  svg_root',
    '  canvas',
    '  iframe [ref=4, loc=unstable]',
    '    root',
    '  list',
    '    list_item',
    '  table',
    '    table_row',
    '      table_cell',
  ].join('\n');

  const compact = [
    'root',
    '  button [ref=1]',
    '    text "Save"',
    '  container',
    '    text "A"',
    '    text "B"',
    '  container "Section"',
    '    text "Title"',
    '  container [ref=2]',
    '  button [ref=3, loc=css:#confirm]',
    '  button [ref=5, loc=css:[loc=unstable]]',
    '  anchor [ref=6, url=https://example.com/item]',
    '  text "literal [ref=9, loc=unstable]"',
    '  image',
    '  svg_root',
    '  canvas',
    '  iframe [ref=4]',
    '    root',
    '  list',
    '    list_item',
    '  table',
    '    table_row',
    '      table_cell',
  ].join('\n');

  expect(compactSnapshotContent(content)).toBe(compact);
  expect(compactSnapshotContent(compact)).toBe(compact);
  expect(compactSnapshotContent('snapshot unavailable')).toBe('snapshot unavailable');
});

test('snapshot compaction omits unusable locator statuses from refs', () => {
  const result: SnapshotResult = {
    content: [
      'root',
      '  button [ref=1, loc=unstable]',
      '  button [ref=2, loc=ambiguous]',
      '  button [ref=3, loc=css:#save]',
    ].join('\n'),
    refs: [
      { refId: 1, backendNodeId: 1, loc: 'unstable' },
      { refId: 2, backendNodeId: 2, loc: 'ambiguous' },
      { refId: 3, backendNodeId: 3, loc: 'css:#save' },
    ],
  };

  compactSnapshotResult(result);

  expect(result.content).toBe(
    ['root', '  button [ref=1]', '  button [ref=2]', '  button [ref=3, loc=css:#save]'].join('\n'),
  );
  expect(refsOf(result)[0]?.loc).toBeUndefined();
  expect(refsOf(result)[1]?.loc).toBeUndefined();
  expect(refsOf(result)[2]?.loc).toBe('css:#save');
});

test('snapshot locator validation batches DOM queries and object cleanup', async () => {
  const calls: [string, CdpObject, string | undefined][] = [];
  const services = {
    cdp: fakeCdp((method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      if (method === 'Runtime.evaluate' && params.returnByValue) {
        return { result: { value: [1, 1] } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'locator-batch' } };
      }
      if (method === 'Runtime.getProperties') {
        return {
          result: [
            { name: '0', value: { objectId: 'node:10' } },
            { name: '1', value: { objectId: 'node:11' } },
          ],
        };
      }
      if (method === 'DOM.describeNode') {
        return {
          node: {
            backendNodeId: Number(objectSuffix(params, 'node:')),
          },
        };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      throw new Error(`unexpected CDP method: ${method}`);
    }),
  };
  const result: SnapshotResult = {
    content: ['button A [ref=10, loc=css:#a]', 'button B [ref=11, loc=css:#b]'].join('\n'),
    refs: [
      { backendNodeId: 10, loc: 'css:#a' },
      { backendNodeId: 11, loc: 'css:#b' },
    ],
  };

  await preparePageSnapshotResult(services, 'session:page', new Map(), result);

  expect(refsOf(result)[0]?.loc).toBe('css:#a');
  expect(refsOf(result)[1]?.loc).toBe('css:#b');
  expect(calls.filter(([method]) => method === 'Runtime.evaluate').length).toBe(2);
  expect(calls.filter(([method]) => method === 'Runtime.getProperties').length).toBe(1);
  expect(calls.filter(([method]) => method === 'DOM.describeNode').length).toBe(2);
  expect(calls.filter(([method]) => method === 'Runtime.releaseObjectGroup').length).toBe(1);
  expect(calls.some(([method]) => method === 'Runtime.releaseObject')).toBe(false);
});

test('DOM locator validation keeps healthy contexts when one count fails', async () => {
  const cdp = {
    sendRaw: fakeCdp((method, params, sessionId) => {
      if (sessionId === 'session:detached') {
        throw new Error('frame detached');
      }
      if (method === 'Runtime.evaluate' && params.returnByValue) {
        return { result: { value: [1] } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'locator-batch' } };
      }
      if (method === 'Runtime.getProperties') {
        return {
          result: [{ name: '0', value: { objectId: 'node:10' } }],
        };
      }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: 10 } };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      throw new Error(`unexpected CDP method: ${method}`);
    }),
  };

  expect(
    await validateSnapshotLocator(
      cdp,
      'session:page',
      new Map([['frame-detached', 'session:detached']]),
      { backendNodeId: 10, loc: 'css:#save' },
    ),
  ).toBe(true);
});

test('DOM locator validation keeps the Page when an iframe world disappears', async () => {
  const cdp = {
    sendRaw: fakeCdp((method, params) => {
      if (method === 'Page.createIsolatedWorld') {
        throw new Error('frame detached');
      }
      if (method === 'Runtime.evaluate' && params.returnByValue) {
        return { result: { value: [1] } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'locator-batch' } };
      }
      if (method === 'Runtime.getProperties') {
        return {
          result: [{ name: '0', value: { objectId: 'node:10' } }],
        };
      }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: 10 } };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      throw new Error(`unexpected CDP method: ${method}`);
    }),
  };

  expect(
    await validateSnapshotLocator(
      cdp,
      'session:page',
      new Map([['frame-detached', 'session:page']]),
      { backendNodeId: 10, loc: 'css:#save' },
    ),
  ).toBe(true);
});

test('role locator validation keeps healthy trees when one frame detaches', async () => {
  const cdp = {
    sendRaw: fakeCdp((method, _params, sessionId) => {
      expect(method).toBe('Accessibility.getFullAXTree');
      if (sessionId === 'session:detached') {
        throw new Error('frame detached');
      }
      return {
        nodes: [
          {
            backendDOMNodeId: 10,
            ignored: false,
            role: { value: 'button' },
            name: { value: 'Save' },
          },
        ],
      };
    }),
  };

  expect(
    await validateSnapshotLocator(
      cdp,
      'session:page',
      new Map([['frame-detached', 'session:detached']]),
      {
        backendNodeId: 10,
        loc: 'role:button[name="Save"]',
      },
    ),
  ).toBe(true);
});

test('invalid native snapshot locators are hidden without removing their refs', async () => {
  const result: SnapshotResult = {
    content: [
      'textfield "Prompt" [ref=10, loc=css:#prompt, url=https://example.com/prompt]',
      'text "literal ref=10, loc=css:#prompt"',
      'button "Save" [ref=11, loc=role:button[name="Save"]]',
    ].join('\n'),
    refs: [
      {
        backendNodeId: 10,
        role: 'textfield',
        name: 'Prompt',
        loc: 'css:#prompt',
      },
      {
        backendNodeId: 11,
        role: 'button',
        name: 'Save',
        loc: 'role:button[name="Save"]',
      },
    ],
  };

  await sanitizeSnapshotLocators(result, (ref) => Promise.resolve(ref.backendNodeId === 11));

  expect(result.content).toBe(
    [
      'textfield "Prompt" [ref=10, url=https://example.com/prompt]',
      'text "literal ref=10, loc=css:#prompt"',
      'button "Save" [ref=11, loc=role:button[name="Save"]]',
    ].join('\n'),
  );
  expect(refsOf(result)[0]?.loc).toBeUndefined();
  expect(refsOf(result)[1]?.loc).toBe('role:button[name="Save"]');
});

test('stable locator validation requires one match for the original backend node', async () => {
  const responses = new Map([
    ['zero', { count: 0 }],
    ['duplicate', { count: 2 }],
    ['wrong', { count: 1, resolvedBackendNodeId: 99 }],
    ['same', { count: 1, resolvedBackendNodeId: 10 }],
  ]);

  const cdp = {
    sendRaw: fakeCdp((method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        const key = [...responses.keys()].find((candidate) => expression.includes(`#${candidate}`));
        const response = key === undefined ? undefined : responses.get(key);
        if (!response) throw new Error(`unexpected expression: ${expression}`);
        if (params.returnByValue) {
          return { result: { value: [response.count] } };
        }
        return {
          result: {
            objectId: `batch:${String(response.resolvedBackendNodeId)}`,
          },
        };
      }
      if (method === 'Runtime.getProperties') {
        const backendNodeId = objectSuffix(params, 'batch:');
        return {
          result: [{ name: '0', value: { objectId: `node:${backendNodeId}` } }],
        };
      }
      if (method === 'DOM.describeNode') {
        return {
          node: {
            backendNodeId: Number(objectSuffix(params, 'node:')),
          },
        };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      return {};
    }),
  };

  for (const [selector, expected] of [
    ['zero', false],
    ['duplicate', false],
    ['wrong', false],
    ['same', true],
  ] as const) {
    expect(
      await validateSnapshotLocator(cdp, 'session:page', new Map(), {
        backendNodeId: 10,
        loc: `css:#${selector}`,
      }),
      selector,
    ).toBe(expected);
  }
});

test('Page snapshots preserve native ref provenance', async () => {
  const result: SnapshotResult = {
    refs: [
      {
        refId: 1,
        backendNodeId: 6,
        role: 'textbox',
        name: '',
      },
      {
        refId: 17,
        backendNodeId: 6,
        role: 'textbox',
        name: '',
        frameId: 'frame-oopif',
      },
    ],
  };
  const services = {
    cdp: fakeCdp((_method, _params, sessionId) => {
      if (sessionId === 'session:oopif') {
        return {
          nodes: [
            {
              backendDOMNodeId: 6,
              role: { value: 'textbox' },
              name: { value: '' },
            },
          ],
        };
      }
      return { nodes: [] };
    }),
  };

  await preparePageSnapshotResult(
    services,
    'session:page',
    new Map([['frame-oopif', 'session:oopif']]),
    result,
  );

  expect(result.refs).toStrictEqual([
    {
      refId: 1,
      backendNodeId: 6,
      role: 'textbox',
      name: '',
      frameProvenance: 'page',
    },
    {
      refId: 17,
      backendNodeId: 6,
      role: 'textbox',
      name: '',
      frameId: 'frame-oopif',
      frameProvenance: 'frame',
    },
  ]);
});

test('Page snapshots backfill missing frame provenance from a unique locator', async () => {
  const result: SnapshotResult = {
    content: [
      'iframe [ref=12]',
      'root',
      '  button "Run iframe action" [ref=21, loc=role:button[name="Run iframe action"]]',
    ].join('\n'),
    refs: [
      {
        refId: 21,
        backendNodeId: 21,
        role: 'button',
        name: 'Run iframe action',
        loc: 'role:button[name="Run iframe action"]',
      },
    ],
  };
  const services = {
    cdp: fakeCdp((method, params, sessionId) => {
      expect(method).toBe('Accessibility.getFullAXTree');
      if (sessionId === 'session:page' && params.frameId === 'frame-same') {
        return {
          nodes: [
            {
              backendDOMNodeId: 21,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Run iframe action' },
            },
          ],
        };
      }
      return { nodes: [] };
    }),
  };

  await preparePageSnapshotResult(
    services,
    'session:page',
    new Map([
      ['frame-same', 'session:page'],
      ['frame-oopif', 'session:oopif'],
    ]),
    result,
  );

  expect(refsOf(result)[0]?.frameId).toBe('frame-same');
  expect(refsOf(result)[0]?.frameProvenance).toBe('frame');
});

test('Page snapshots do not invent frame provenance for an ambiguous backend node', async () => {
  const result: SnapshotResult = {
    content: [
      'iframe [ref=12]',
      'root',
      '  button "Duplicate action" [ref=21, loc=role:button[name="Duplicate action"]]',
    ].join('\n'),
    refs: [
      {
        refId: 21,
        backendNodeId: 21,
        role: 'button',
        name: 'Duplicate action',
        loc: 'role:button[name="Duplicate action"]',
      },
    ],
  };
  const services = {
    cdp: fakeCdp((method, params, sessionId) => {
      expect(method).toBe('Accessibility.getFullAXTree');
      const isFirstFrame = sessionId === 'session:page' && params.frameId === 'frame-first';
      const isSecondFrame = sessionId === 'session:second';
      return isFirstFrame || isSecondFrame
        ? {
            nodes: [
              {
                backendDOMNodeId: 21,
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Duplicate action' },
              },
            ],
          }
        : { nodes: [] };
    }),
  };

  await preparePageSnapshotResult(
    services,
    'session:page',
    new Map([
      ['frame-first', 'session:page'],
      ['frame-second', 'session:second'],
    ]),
    result,
  );

  expect(refsOf(result)[0]?.frameId).toBeUndefined();
  expect(refsOf(result)[0]?.frameProvenance).toBe('unknown');
});

test('frame provenance ignores a ref token inside an accessible name', async () => {
  const result: SnapshotResult = {
    content: [
      'root',
      '  link "See [ref=3] in the spec" [ref=3]',
      '  iframe [ref=12]',
      '    root',
      '      link "See [ref=3] in the spec" [ref=42]',
    ].join('\n'),
    refs: [
      {
        refId: 3,
        backendNodeId: 3,
        role: 'link',
        name: 'See [ref=3] in the spec',
      },
      {
        refId: 42,
        backendNodeId: 42,
        role: 'link',
        name: 'See [ref=3] in the spec',
      },
    ],
  };

  await preparePageSnapshotResult(
    {
      cdp: fakeCdp(() => ({ nodes: [] })),
    },
    'session:page',
    new Map([['frame-child', 'session:page']]),
    result,
  );

  // The page-owned ref must not be re-homed by a quoted ref token.
  expect(refsOf(result)[0]?.frameProvenance).toBe('page');
  // The frame-owned ref must still be recognised as a frame descendant.
  expect(refsOf(result)[1]?.frameProvenance).toBe('frame');
  expect(refsOf(result)[1]?.frameId).toBe('frame-child');
});
