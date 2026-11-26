// Ported from ego-browser package/ego-browser/src/public-api-schema.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; `requestAccess` joins the entry points.

import { expect, test } from 'vitest';

import { PUBLIC_API_SCHEMA, validatePublicApiOptions } from './public-api-schema.js';

test('the public API schema contains the v2 entry points and object methods', () => {
  const names = new Set(PUBLIC_API_SCHEMA.map((entry) => entry.name));
  for (const name of [
    'profiles',
    'listTaskSpaces',
    'taskSpace',
    'claimTaskSpace',
    'takeOverTaskSpace',
    'requestAccess',
    'TaskSpace.spaceId',
    'TaskSpace.userPage',
    'TaskSpace.pages',
    'TaskSpace.tabs',
    'TaskSpace.newPage',
    'TaskSpace.finish',
    'Page.snapshot',
    'Page.reload',
    'Page.targetId',
    'Page.waitForEvent',
    'Download.page',
    'Download.url',
    'Download.suggestedFilename',
    'Download.saveAs',
    'Download.path',
    'Download.failure',
    'Download.cancel',
    'Download.delete',
    'Page.waitForURL',
    'Page.waitForTimeout',
    'Page.waitForFunction',
    'Page.acceptDialog',
    'Page.dismissDialog',
    'Page.focus',
    'Page.press',
    'Page.selectOption',
    'Page.keyboard.press',
    'Page.keyboard.paste',
  ]) {
    expect(names.has(name), `missing public API schema entry: ${name}`).toBe(true);
  }
  expect(names.has('showTaskState')).toBe(false);
  expect(names.has('TaskSpace.listPages')).toBe(false);
  expect(names.has('TaskSpace.close')).toBe(false);
  expect(names.has('Page.scrollBy')).toBe(false);
});

test('Page.waitForFunction documents what it resolves to', () => {
  const entry = PUBLIC_API_SCHEMA.find((item) => item.name === 'Page.waitForFunction');
  expect(entry?.summary).toMatch(/resolves? to true, not (that|the predicate's) value/i);
  expect(entry?.summary).toMatch(/page\.evaluate\(\)/);
});

test('schema-driven option validation rejects unknown and invalid fields', () => {
  validatePublicApiOptions('taskSpace', { profileId: 'Profile 2' });
  validatePublicApiOptions('Page.click', {
    button: 'left',
    clickCount: 2,
    delay: 0,
    force: true,
    timeout: 500,
    label: 'open account settings',
  });
  validatePublicApiOptions('Page.mouse.wheel', {
    label: 'scroll project board',
  });
  // The schema still accepts these options; page-model refuses them with PiArc's guidance.
  validatePublicApiOptions('Page.fetch', { saveAs: '/tmp/image.png' });
  validatePublicApiOptions('Page.screenshot', {
    path: '/tmp/image.png',
    scale: 'css',
  });
  validatePublicApiOptions('Page.snapshot', {
    scope: 'subtree',
    root: '@21',
  });
  validatePublicApiOptions('TaskSpace.finish', { keep: [] });
  validatePublicApiOptions('TaskSpace.finish', { keep: ['p2'] });
  validatePublicApiOptions('TaskSpace.finish', { keep: 'all' });
  for (const waitUntil of ['commit', 'domcontentloaded', 'load', 'networkidle']) {
    validatePublicApiOptions('Page.goto', {
      referer: 'https://example.test/source',
      waitUntil,
    });
  }

  expect(() => {
    validatePublicApiOptions('taskSpace', { profileId: '' });
  }).toThrow(/taskSpace profileId must be a non-empty string/);
  expect(() => {
    validatePublicApiOptions('Page.click', { trial: true });
  }).toThrow(
    /unknown option: trial\. Expected: await page\.click\(selector, \{ button\?, clickCount\?, delay\?, position\?, force\?, timeout\?, label\? \}\)/,
  );
  expect(() => {
    validatePublicApiOptions('Page.screenshot', { scale: 'invalid' });
  }).toThrow(/scale must be one of css/);
  expect(() => {
    validatePublicApiOptions('Page.screenshot', { scale: 'device' });
  }).toThrow(/scale must be one of css/);
  expect(() => {
    validatePublicApiOptions('Page.goto', { timeout: 0 });
  }).toThrow(/timeout must be a positive number of milliseconds/);
  expect(() => {
    validatePublicApiOptions('Page.goto', { waitUntil: 'interactive' });
  }).toThrow(/waitUntil must be one of commit, domcontentloaded, load, networkidle/);
  expect(() => {
    validatePublicApiOptions('Page.snapshot', { root: 21 });
  }).toThrow(/root must be a non-empty string/);
  expect(() => {
    validatePublicApiOptions('Page.waitForFunction', { polling: 0 });
  }).toThrow(/polling must be a positive number of milliseconds/);
  expect(() => {
    validatePublicApiOptions('Page.click', { button: 'primary' });
  }).toThrow(/button must be one of left, middle, right/);
  expect(() => {
    validatePublicApiOptions('TaskSpace.finish', { keep: true });
  }).toThrow(/keep must be "all" or an array of unique non-empty Page labels/);
  expect(() => {
    validatePublicApiOptions('TaskSpace.finish', { keep: ['p2', 'p2'] });
  }).toThrow(/keep must be "all" or an array of unique non-empty Page labels/);
});
