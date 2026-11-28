import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { parseBrowserRequest, parsePlacement } = await import('./browser-ipc.js');

const prompt = '0f8c4a2e-6b1d-4c3e-9a7f-2d5b8e1c3f60';

describe('parseBrowserRequest', () => {
  it.each([
    [{ op: 'state' }],
    [{ op: 'navigate', input: 'localhost:5173' }],
    [{ op: 'navigate', tab: 'tab-3', input: 'example.com' }],
    [{ op: 'newTab' }],
    [{ op: 'newTab', url: 'https://example.com', background: true }],
    [{ op: 'closeTab', tab: 'tab-1' }],
    [{ op: 'moveTab', tab: 'tab-1', index: 2 }],
    [{ op: 'history', tab: 'tab-1', direction: 'back' }],
    [{ op: 'reload', tab: 'tab-1', hard: true }],
    [{ op: 'zoom', tab: 'tab-1', step: 'reset' }],
    [{ op: 'find', tab: 'tab-1', text: 'abc', forward: true, next: false }],
    [{ op: 'devtools', tab: 'tab-1', mode: 'docked' }],
    [
      {
        op: 'emulate',
        tab: 'tab-1',
        emulation: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
      },
    ],
    [{ op: 'emulate', tab: 'tab-1', emulation: null }],
    [{ op: 'media', tab: 'tab-1', media: { colorScheme: 'dark', reducedMotion: false } }],
    [{ op: 'answer', prompt, accept: true, user: 'me', password: 'secret' }],
    [{ op: 'download', download: prompt, action: 'show' }],
    [{ op: 'clearData' }],
    [{ op: 'still' }],
  ])('accepts %j', (request) => {
    expect(parseBrowserRequest(request)).toEqual(request);
  });

  it.each([
    [null],
    ['state'],
    [{ op: 'unknown' }],
    [{ op: 'closeTab', tab: '../etc' }],
    [{ op: 'closeTab', tab: 7 }],
    [{ op: 'navigate', input: 'x'.repeat(9000) }],
    [{ op: 'navigate', input: 42 }],
    [{ op: 'moveTab', tab: 'tab-1', index: -1 }],
    [{ op: 'history', tab: 'tab-1', direction: 'up' }],
    [{ op: 'zoom', tab: 'tab-1', step: 2 }],
    [{ op: 'find', tab: 'tab-1', text: 'a', forward: 'yes', next: false }],
    [{ op: 'devtools', tab: 'tab-1', mode: 'bottom' }],
    [
      {
        op: 'emulate',
        tab: 'tab-1',
        emulation: { width: 10, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
      },
    ],
    [{ op: 'media', tab: 'tab-1', media: { colorScheme: 'blue', reducedMotion: false } }],
    [{ op: 'answer', prompt: 'p', accept: true }],
    [{ op: 'answer', prompt, accept: 'yes' }],
    [{ op: 'download', download: prompt, action: 'open' }],
  ])('THR-11 rejects %j', (request) => {
    expect(() => parseBrowserRequest(request)).toThrow(TypeError);
  });
});

describe('parsePlacement', () => {
  it('accepts null and a rectangle', () => {
    expect(parsePlacement(null)).toBeNull();
    const placement = { bounds: { x: 1, y: 2, width: 300, height: 400 }, occluded: false };
    expect(parsePlacement(placement)).toEqual(placement);
  });

  it.each([
    [{ bounds: { x: 1, y: 2, width: -1, height: 4 }, occluded: false }],
    [{ bounds: { x: 1, y: 2, width: Number.NaN, height: 4 }, occluded: false }],
    [{ bounds: { x: 1, y: 2, width: 1, height: 4 }, occluded: 'no' }],
    [{ bounds: { x: 1, y: 2, width: 1, height: 4 }, occluded: false, toolWindow: 5 }],
    ['bounds'],
  ])('rejects %j', (placement) => {
    expect(() => parsePlacement(placement)).toThrow(TypeError);
  });
});

describe('start page requests (B1.1.1, B1.2.3, B1.6.2, B4.2)', () => {
  it.each([
    [{ op: 'startPage' }],
    [{ op: 'openHtmlFile' }],
    [{ op: 'startServer', name: 'web' }],
    [{ op: 'stopServer', name: 'API server' }],
    [{ op: 'suggest', input: 'local' }],
    [{ op: 'navigate', input: 'localhost:5173', newTab: true }],
  ])('accepts %j', (request) => {
    expect(parseBrowserRequest(request)).toEqual(request);
  });

  it('drops a newTab flag that is false', () => {
    expect(parseBrowserRequest({ op: 'navigate', input: 'a.test', newTab: false })).toEqual({
      op: 'navigate',
      input: 'a.test',
    });
  });

  it.each([
    [{ op: 'startServer' }],
    [{ op: 'startServer', name: '' }],
    [{ op: 'startServer', name: '   ' }],
    [{ op: 'stopServer', name: 'x'.repeat(201) }],
    [{ op: 'suggest', input: 7 }],
    [{ op: 'navigate', input: 'a', newTab: 'yes' }],
    [{ op: 'navigate', tab: 'tab-1', input: 'a', newTab: true }],
  ])('THR-11 rejects %j', (request) => {
    expect(() => parseBrowserRequest(request)).toThrow(TypeError);
  });
});

describe('console requests (B1.4.3)', () => {
  it.each([
    [{ op: 'console', tab: 'tab-1', after: 0 }],
    [{ op: 'console', tab: 'tab-1', after: 1200 }],
    [{ op: 'consoleClear', tab: 'tab-1' }],
  ])('accepts %j', (request) => {
    expect(parseBrowserRequest(request)).toEqual(request);
  });

  it.each([
    [{ op: 'console', tab: 'tab-1' }],
    [{ op: 'console', tab: 'tab-1', after: -1 }],
    [{ op: 'console', tab: 'tab-1', after: 1.5 }],
    [{ op: 'consoleClear', tab: '../x' }],
  ])('THR-11 rejects %j', (request) => {
    expect(() => parseBrowserRequest(request)).toThrow(TypeError);
  });
});
