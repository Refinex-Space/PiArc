// Ported from ego-browser package/ego-browser/src/driver/action-target.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; the page-side helpers are evaluated with indirect
// `eval` instead of `Function(...)`.

import { expect, test } from 'vitest';

import {
  ACTION_TARGET_STATE_HELPERS,
  HIT_TARGET_HELPERS,
  SCROLL_TARGET_HELPERS,
} from './action-target.js';

/** Evaluates page-side helper source and answers the named functions. */
function pageFunctions(helpers: string, names: string): unknown {
  const evaluate: (source: string) => unknown = globalThis.eval;
  return evaluate(`(() => {\n${helpers}\nreturn { ${names} };\n})()`);
}

interface StateHelpers {
  isActionTargetDisabled: (element: unknown) => boolean;
}

function stateHelpers(): StateHelpers {
  return pageFunctions(ACTION_TARGET_STATE_HELPERS, 'isActionTargetDisabled') as StateHelpers;
}

interface ElementOptions {
  tagName?: string;
  parentElement?: unknown;
  assignedSlot?: unknown;
  rootHost?: unknown;
  disabled?: boolean;
  ariaDisabled?: string;
  role?: string;
  href?: boolean;
  contentEditable?: boolean;
}

function element({
  tagName = 'DIV',
  parentElement = null,
  assignedSlot = null,
  rootHost = null,
  disabled = false,
  ariaDisabled,
  role,
  href = false,
  contentEditable = false,
}: ElementOptions = {}) {
  return {
    tagName,
    parentElement,
    assignedSlot,
    disabled,
    isContentEditable: contentEditable,
    getAttribute(name: string) {
      if (name === 'aria-disabled') return ariaDisabled ?? null;
      if (name === 'role') return role ?? null;
      return null;
    },
    hasAttribute(name: string) {
      return name === 'href' ? href : false;
    },
    getRootNode() {
      return rootHost ? { nodeType: 11, host: rootHost } : { nodeType: 9 };
    },
    matches(selector: string) {
      expect(selector).toBe(':disabled');
      return disabled;
    },
  };
}

test('action enabled state follows native controls and composed ARIA ancestry', () => {
  const { isActionTargetDisabled } = stateHelpers();

  const disabledButton = element({ tagName: 'BUTTON', disabled: true });
  const nestedSpan = element({
    tagName: 'SPAN',
    parentElement: disabledButton,
  });
  expect(isActionTargetDisabled(nestedSpan)).toBe(true);

  const ariaContainer = element({ ariaDisabled: ' TRUE ' });
  const inherited = element({
    tagName: 'BUTTON',
    parentElement: ariaContainer,
  });
  expect(isActionTargetDisabled(inherited)).toBe(true);

  const overridden = element({
    tagName: 'BUTTON',
    parentElement: ariaContainer,
    ariaDisabled: 'false',
  });
  expect(isActionTargetDisabled(overridden)).toBe(false);

  const nativeWins = element({
    tagName: 'BUTTON',
    disabled: true,
    ariaDisabled: 'false',
  });
  expect(isActionTargetDisabled(nativeWins)).toBe(true);
});

test('action enabled state crosses shadow hosts and assigned slots', () => {
  const { isActionTargetDisabled } = stateHelpers();

  const host = element({ ariaDisabled: 'true' });
  const shadowChild = element({ tagName: 'BUTTON', rootHost: host });
  expect(isActionTargetDisabled(shadowChild)).toBe(true);

  const slot = element({ tagName: 'SLOT', rootHost: host });
  const slottedChild = element({ tagName: 'BUTTON', assignedSlot: slot });
  expect(isActionTargetDisabled(slottedChild)).toBe(true);

  const slottedOverride = element({
    tagName: 'BUTTON',
    assignedSlot: slot,
    ariaDisabled: 'false',
  });
  expect(isActionTargetDisabled(slottedOverride)).toBe(false);
});

test('action enabled state uses the nearest interactive owner for ARIA', () => {
  const { isActionTargetDisabled } = stateHelpers();

  const disabledButton = element({
    tagName: 'BUTTON',
    ariaDisabled: 'true',
  });
  const unsupportedOverride = element({
    tagName: 'SPAN',
    parentElement: disabledButton,
    ariaDisabled: 'false',
  });
  expect(
    isActionTargetDisabled(unsupportedOverride),
    'aria-disabled=false on button content does not override the button',
  ).toBe(true);

  const innerButton = element({
    parentElement: disabledButton,
    role: 'button',
    ariaDisabled: 'false',
  });
  const innerText = element({ tagName: 'SPAN', parentElement: innerButton });
  expect(
    isActionTargetDisabled(innerText),
    'a nested interactive owner can explicitly override its ancestor',
  ).toBe(false);

  const unsupportedTarget = element({ ariaDisabled: 'true' });
  expect(
    isActionTargetDisabled(unsupportedTarget),
    'aria-disabled does not disable a target without a supporting role',
  ).toBe(false);
});

test('scroll targeting recognizes an element clipped by a nested scroller', () => {
  const { scrollRequestForPoint } = pageFunctions(
    SCROLL_TARGET_HELPERS,
    'scrollRequestForPoint',
  ) as {
    scrollRequestForPoint: (target: unknown, point: { x: number; y: number }) => unknown;
  };
  const body = { parentElement: null };
  const documentElement = { parentElement: null };
  const view = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle() {
      return { overflowX: 'hidden', overflowY: 'auto' };
    },
  };
  const ownerDocument = { body, documentElement, defaultView: view };
  const scroller = {
    ownerDocument,
    parentElement: body,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 300,
    clientWidth: 300,
    scrollHeight: 900,
    clientHeight: 120,
    getBoundingClientRect() {
      return { left: 20, top: 100, right: 320, bottom: 220 };
    },
  };
  const target = { ownerDocument, parentElement: scroller };

  expect(scrollRequestForPoint(target, { x: 80, y: 700 })).toEqual({
    x: 170,
    y: 160,
    deltaX: 0,
    deltaY: 540,
  });
  expect(scrollRequestForPoint(target, { x: 80, y: 160 })).toBeNull();
});

test('action targeting chooses a real inline fragment instead of the bounding-box gap', () => {
  const { actionPointForElement } = pageFunctions(HIT_TARGET_HELPERS, 'actionPointForElement') as {
    actionPointForElement: (target: unknown) => unknown;
  };
  const target = {
    ownerDocument: {
      defaultView: { innerWidth: 800, innerHeight: 600 },
    },
    getClientRects() {
      return [
        { left: 700, top: 100, right: 780, bottom: 120, width: 80, height: 20 },
        { left: 20, top: 140, right: 100, bottom: 160, width: 80, height: 20 },
      ];
    },
    getBoundingClientRect() {
      return {
        left: 20,
        top: 100,
        right: 780,
        bottom: 160,
        width: 760,
        height: 60,
      };
    },
  };

  expect(actionPointForElement(target)).toEqual({ x: 740, y: 110 });
});
