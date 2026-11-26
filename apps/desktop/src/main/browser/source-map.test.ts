import { describe, expect, it } from 'vitest';

import {
  decodeMappings,
  mapSource,
  originalPosition,
  parseSourceMap,
  parseStack,
  sourceMappingUrl,
  usageFrame,
} from './source-map.js';

/** A React 19 `_debugStack` as V8 prints it. */
const DEBUG_STACK = [
  'Error: react-stack-top-frame',
  '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:19)',
  '    at App (http://localhost:5173/src/App.tsx?t=17:22:7)',
  '    at react-stack-bottom-frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:17424:20)',
  '    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:4206:24)',
].join('\n');

describe('stacks', () => {
  it('parses V8 frames with and without a function name', () => {
    expect(parseStack('Error: x\n    at f (http://h/a.js:1:2)\n    at http://h/b.js:3:4')).toEqual([
      { fn: 'f', file: 'http://h/a.js', line: 1, column: 2 },
      { file: 'http://h/b.js', line: 3, column: 4 },
    ]);
  });

  it('takes the frame after the JSX factory, above React’s bottom frame', () => {
    expect(usageFrame(DEBUG_STACK)).toEqual({
      fn: 'App',
      file: 'http://localhost:5173/src/App.tsx?t=17',
      line: 22,
      column: 7,
    });
  });

  it('ignores stacks not captured during a render', () => {
    expect(usageFrame(DEBUG_STACK.split('\n').slice(0, 3).join('\n'))).toBeUndefined();
  });
});

describe('source maps', () => {
  it('finds the last sourceMappingURL comment', () => {
    const code =
      'a()\n//# sourceMappingURL=old.map\nb()\n//# sourceMappingURL=data:application/json;base64,e30=';
    expect(sourceMappingUrl(code)).toBe('data:application/json;base64,e30=');
    expect(sourceMappingUrl('no map')).toBeUndefined();
  });

  it('decodes VLQ mappings with state carried across lines', () => {
    // Line 1: column 0 → source 0, line 10, column 0; line 2: column 4 → line 11, column 2.
    expect(decodeMappings('AAUA;IACE')).toEqual([[[0, 0, 10, 0]], [[4, 0, 11, 2]]]);
    expect(decodeMappings('A$')).toBeUndefined();
  });

  it('maps a served position to the original line (1-based)', () => {
    const map = parseSourceMap({ version: 3, sources: ['App.tsx'], mappings: 'AAUA;AACA;IACE' });
    expect(map).toBeDefined();
    if (map === undefined) return;
    expect(originalPosition(map, 2, 1)).toEqual({ source: 0, line: 12, column: 1 });
    expect(originalPosition(map, 3, 9)).toEqual({ source: 0, line: 13, column: 3 });
    expect(originalPosition(map, 9, 1)).toBeUndefined();
  });

  it('refuses maps that are not version 3 or do not decode', () => {
    expect(parseSourceMap({ version: 2, sources: [], mappings: '' })).toBeUndefined();
    expect(parseSourceMap({ version: 3, sources: 'x', mappings: '' })).toBeUndefined();
    expect(parseSourceMap({ version: 3, sources: [], mappings: '!!' })).toBeUndefined();
  });

  it('resolves sources against the map and its sourceRoot', () => {
    const relative = { sources: ['App.tsx'], sourceRoot: '', mappings: [] };
    expect(mapSource(relative, 0, 'http://h:1/src/App.tsx')).toBe('http://h:1/src/App.tsx');
    const rooted = { sources: ['App.tsx'], sourceRoot: '/src', mappings: [] };
    expect(mapSource(rooted, 0, 'http://h:1/assets/x.js.map')).toBe('http://h:1/src/App.tsx');
    const absolute = {
      sources: ['/repo/src/App.tsx', 'webpack://app/./src/B.tsx'],
      sourceRoot: '',
      mappings: [],
    };
    expect(mapSource(absolute, 0, 'http://h:1/x.js')).toBe('/repo/src/App.tsx');
    expect(mapSource(absolute, 1, 'http://h:1/x.js')).toBe('webpack://app/./src/B.tsx');
  });
});
