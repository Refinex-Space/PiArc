import path from 'node:path';
import { runInThisContext } from 'node:vm';

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import {
  buildContext,
  capBytes,
  containedSource,
  elementClip,
  elementInfo,
  ELEMENT_FACTS,
  FACT_LIMITS,
  FRAMEWORK_FACTS,
  locateSource,
  parseFacts,
  parseFramework,
  sourceCandidates,
  styleDiff,
  type SourceIo,
} from './element-context.js';

/** Runs one of the page functions on `element` as `Runtime.callFunctionOn` would. */
function run(source: string, element: unknown, ...args: unknown[]): unknown {
  const fn: unknown = runInThisContext(`(${source})`);
  if (typeof fn !== 'function') throw new Error('not a function');
  return Reflect.apply(fn, element, args);
}

function page(markup: string) {
  const window = new Window({ url: 'http://localhost:5173/' });
  const parser = new window.DOMParser();
  const parsed = parser.parseFromString(
    `<!doctype html><html><body>${markup}</body></html>`,
    'text/html',
  );
  const document = window.document;
  for (const child of [...parsed.body.childNodes]) {
    document.body.appendChild(document.importNode(child, true));
  }
  return { window, document };
}

describe('the page’s DOM facts', () => {
  it('builds a unique selector and an XPath', () => {
    const { document } = page(
      '<main id="app"><ul><li><button class="btn primary">A</button></li><li><button class="btn primary">B</button></li></ul></main>',
    );
    const buttons = document.querySelectorAll('button');
    const second = buttons[1];
    const facts = parseFacts(run(ELEMENT_FACTS, second, FACT_LIMITS));
    expect(facts?.tag).toBe('button');
    // The shortest suffix of the path that matches only this element.
    expect(facts?.selector).toBe('li:nth-of-type(2) > button.btn.primary');
    expect(document.querySelectorAll(facts?.selector ?? '')).toHaveLength(1);
    expect(facts?.xpath).toBe('//*[@id="app"]/ul/li[2]/button');
    expect(facts?.text).toBe('B');
  });

  it('prefers a unique test id and keeps only allow-listed attributes', () => {
    const { document } = page(
      '<div><a data-testid="save" href="javascript:alert(1)" onclick="x()" aria-label="Save" style="color:red" title="t">Save</a></div>',
    );
    const facts = parseFacts(run(ELEMENT_FACTS, document.querySelector('a'), FACT_LIMITS));
    expect(facts?.selector).toBe('a[data-testid="save"]');
    expect(facts?.attributes).toEqual({
      'data-testid': 'save',
      href: 'javascript:',
      'aria-label': 'Save',
      title: 't',
    });
  });

  it('removes scripts and event attributes and masks password values', () => {
    const { document } = page(
      '<form id="f" onsubmit="steal()"><input type="password" value="hunter2"><input type="hidden" name="csrf" value="tok"><input name="q" value="shown"><script>evil()</script><a href="javascript:void(0)">x</a></form>',
    );
    const facts = parseFacts(run(ELEMENT_FACTS, document.querySelector('form'), FACT_LIMITS));
    const html = facts?.html ?? '';
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('tok');
    expect(html).toContain('value="shown"');
    expect(html).toContain('••••');
    expect(html).not.toContain('onsubmit');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  it('cuts long text and markup in the page and again here', () => {
    const { document } = page(`<p>${'word '.repeat(400)}</p>`);
    const facts = parseFacts(run(ELEMENT_FACTS, document.querySelector('p'), FACT_LIMITS));
    expect(facts?.text.length).toBeLessThanOrEqual(FACT_LIMITS.text);
    expect(facts?.html.length).toBeLessThanOrEqual(FACT_LIMITS.html);
  });
});

describe('the page’s framework facts', () => {
  it('reads a React 18 fiber: components innermost first and _debugSource', () => {
    const { document } = page('<button>Go</button>');
    const button = document.querySelector('button');
    function Inner() {
      return null;
    }
    function Outer() {
      return null;
    }
    Reflect.set(button ?? {}, '__reactFiber$abc', {
      type: 'button',
      _debugSource: { fileName: '/repo/src/App.tsx', lineNumber: 12, columnNumber: 7 },
      return: { type: Inner, return: { type: { $$typeof: 1, render: Outer }, return: null } },
    });
    expect(parseFramework(run(FRAMEWORK_FACTS, button))).toEqual({
      framework: 'react',
      components: ['Inner', 'Outer'],
      source: { file: '/repo/src/App.tsx', line: 12, column: 7 },
    });
  });

  it('reads Vue’s __file and Svelte’s location (0-based in Svelte 4)', () => {
    const { document } = page('<div id="v"></div><span id="s"></span>');
    Reflect.set(document.querySelector('#v') ?? {}, '__vueParentComponent', {
      type: { __name: 'Hello', __file: '/repo/src/Hello.vue' },
      parent: { type: { name: 'App' }, parent: null },
    });
    Reflect.set(document.querySelector('#s') ?? {}, '__svelte_meta', {
      loc: { file: 'src/App.svelte', line: 4, column: 2, char: 40 },
    });
    expect(parseFramework(run(FRAMEWORK_FACTS, document.querySelector('#v')))).toEqual({
      framework: 'vue',
      components: ['Hello', 'App'],
      source: { file: '/repo/src/Hello.vue' },
    });
    expect(parseFramework(run(FRAMEWORK_FACTS, document.querySelector('#s')))).toEqual({
      framework: 'svelte',
      components: ['App'],
      source: { file: 'src/App.svelte', line: 5, column: 3 },
    });
  });

  it('drops malformed answers', () => {
    expect(parseFramework({ framework: 'react', components: [1, '', 'A\u0000'] })).toEqual({
      framework: 'react',
      components: ['A'],
    });
    expect(parseFramework({ framework: 'angular', source: { file: 'x', line: -1 } })).toEqual({
      framework: '',
      components: [],
      source: { file: 'x' },
    });
    expect(parseFacts({ tag: 1 })).toBeUndefined();
  });
});

describe('shaping the context', () => {
  it('caps markup by UTF-8 bytes on a character boundary', () => {
    expect(capBytes('abc', 3)).toBe('abc');
    const cut = capBytes('中文中文中文', 10);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('keeps 2 KB of markup, 800 B when the source is known', () => {
    const facts = parseFacts({ tag: 'div', selector: 'div', html: 'x'.repeat(4000) });
    if (facts === undefined) throw new Error('facts');
    const accessibility = { role: 'generic', name: '' };
    const framework = { framework: '' as const, components: [] };
    const without = buildContext(
      'http://h/',
      facts,
      framework,
      accessibility,
      facts.box,
      undefined,
    );
    const withSource = buildContext('http://h/', facts, framework, accessibility, facts.box, {
      path: 'src/App.tsx',
      line: 3,
    });
    expect(new TextEncoder().encode(without.html).length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(withSource.html).length).toBeLessThanOrEqual(800);
  });

  it('reports styles that differ from the defaults, at most 20', () => {
    const self = {
      display: 'flex',
      position: 'static',
      top: '10px',
      'margin-top': '8px',
      'margin-right': '16px',
      'margin-bottom': '8px',
      'margin-left': '16px',
      'padding-top': '0px',
      'padding-right': '0px',
      'padding-bottom': '0px',
      'padding-left': '0px',
      'background-color': 'rgba(0, 0, 0, 0)',
      color: 'rgb(255, 0, 0)',
      'font-size': '16px',
      gap: '4px',
      opacity: '1',
    };
    const parent = { color: 'rgb(0, 0, 0)', 'font-size': '16px' };
    expect(styleDiff(self, parent, 'div')).toEqual({
      display: 'flex',
      margin: '8px 16px',
      color: 'rgb(255, 0, 0)',
      gap: '4px',
    });
    expect(styleDiff({ display: 'inline' }, {}, 'span')).toEqual({});
    const many = Object.fromEntries(
      ['opacity', 'cursor', 'transform', 'box-shadow', 'border-radius', 'z-index'].map((name) => [
        name,
        'x',
      ]),
    );
    expect(
      Object.keys(styleDiff({ ...self, ...many, position: 'relative' }, parent, 'div')).length,
    ).toBeLessThanOrEqual(20);
  });

  it('clips an element with a 16 px margin and a long edge of at most 1,200 px', () => {
    expect(elementClip({ x: 10, y: 20, width: 100, height: 50 }, { x: 0, y: 300 }, 2)).toEqual({
      x: 0,
      y: 304,
      width: 126,
      height: 82,
      scale: 1,
    });
    const wide = elementClip({ x: 100, y: 100, width: 3000, height: 100 }, { x: 0, y: 0 }, 2);
    expect(wide?.scale).toBeCloseTo(1200 / (3032 * 2));
    expect(elementClip({ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0 }, 1)).toBeUndefined();
  });
});

describe('the panel’s information card', () => {
  it('lists the computed font, colors and spacing whether or not they are inherited', () => {
    const info = elementInfo({
      display: 'inline-block',
      'font-family': 'Inter, system-ui, sans-serif',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '20px',
      color: 'rgb(17, 24, 39)',
      'background-color': 'rgba(0, 0, 0, 0)',
      'margin-top': '0px',
      'margin-right': '0px',
      'margin-bottom': '0px',
      'margin-left': '0px',
      'padding-top': '8px',
      'padding-right': '16px',
      'padding-bottom': '8px',
      'padding-left': '16px',
      'border-radius': '6px',
      cursor: 'pointer',
    });
    expect(info).toEqual({
      display: 'inline-block',
      'font-family': 'Inter, system-ui, sans-serif',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '20px',
      color: 'rgb(17, 24, 39)',
      'background-color': 'rgba(0, 0, 0, 0)',
      margin: '0px',
      padding: '8px 16px',
      'border-radius': '6px',
    });
  });

  it('leaves out what the page did not report', () => {
    expect(elementInfo({ color: 'red' })).toEqual({ color: 'red' });
  });
});

describe('source locations', () => {
  const root = path.resolve('/work/my app');
  /** A file system with these real paths (`links` map a path to its target). */
  function io(files: readonly string[], links: Record<string, string> = {}): SourceIo {
    return {
      realpath: (file) => {
        const target = links[file] ?? file;
        if (target === root || files.includes(target)) return Promise.resolve(target);
        return Promise.reject(new Error('ENOENT'));
      },
      fetchText: () => Promise.resolve(undefined),
    };
  }

  it('names candidates from URLs, bundler schemes and paths', () => {
    expect(
      sourceCandidates('http://localhost:5173/src/App.tsx?t=1', 'http://localhost:5173/', root),
    ).toEqual([path.join(root, '/src/App.tsx')]);
    expect(
      sourceCandidates('http://evil.test/src/App.tsx', 'http://localhost:5173/', root),
    ).toEqual([]);
    expect(sourceCandidates('webpack://app/./src/App.tsx', 'http://h/', root)).toEqual([
      path.join(root, 'src/App.tsx'),
    ]);
    expect(sourceCandidates('src/App.svelte', 'http://h/', root)).toEqual([
      path.join(root, 'src/App.svelte'),
    ]);
    expect(sourceCandidates('javascript:alert(1)', 'http://h/', root)).toEqual([]);
  });

  it('keeps files inside the workspace, relative with /', async () => {
    const file = path.join(root, 'src', 'App.tsx');
    expect(
      await containedSource({ file, line: 12, column: 3 }, 'http://h/', root, io([file])),
    ).toEqual({
      path: 'src/App.tsx',
      line: 12,
      column: 3,
    });
    // A Vite module path is relative to the project.
    expect(
      await containedSource({ file: '/src/App.tsx', line: 4 }, 'http://h/', root, io([file])),
    ).toEqual({
      path: 'src/App.tsx',
      line: 4,
    });
  });

  it('refuses files outside the workspace, through .. or a link', async () => {
    const outside = path.resolve('/etc/passwd');
    const link = path.join(root, 'linked.ts');
    expect(
      await containedSource({ file: outside }, 'http://h/', root, io([outside])),
    ).toBeUndefined();
    expect(
      await containedSource({ file: '../../etc/passwd' }, 'http://h/', root, io([outside])),
    ).toBeUndefined();
    expect(
      await containedSource({ file: link }, 'http://h/', root, io([outside], { [link]: outside })),
    ).toBeUndefined();
    expect(
      await containedSource({ file: path.join(root, 'missing.ts') }, 'http://h/', root, io([])),
    ).toBeUndefined();
  });

  it('symbolicates a React 19 stack through a same-origin inline source map', async () => {
    const file = path.join(root, 'src', 'App.tsx');
    const map = Buffer.from(
      JSON.stringify({ version: 3, sources: ['App.tsx'], mappings: 'AAUA;AACA;AACA' }),
    ).toString('base64');
    const served = `line1\nline2\nline3\n//# sourceMappingURL=data:application/json;base64,${map}`;
    const stack = [
      'Error: react-stack-top-frame',
      '    at jsxDEV (http://localhost:5173/deps/react.js:1:1)',
      '    at App (http://localhost:5173/src/App.tsx:3:5)',
      '    at react_stack_bottom_frame (http://localhost:5173/deps/react-dom.js:9:9)',
    ].join('\n');
    const fetched: string[] = [];
    const reader: SourceIo = {
      ...io([file]),
      fetchText: (url) => {
        fetched.push(url);
        return Promise.resolve(url === 'http://localhost:5173/src/App.tsx' ? served : undefined);
      },
    };
    expect(
      await locateSource(
        { framework: 'react', components: ['App'], stack },
        'http://localhost:5173/',
        root,
        reader,
      ),
    ).toEqual({ path: 'src/App.tsx', line: 13, column: 1 });
    expect(fetched).toEqual(['http://localhost:5173/src/App.tsx']);
  });
});
