// Helpers of the B3 L4 specs (picker, annotation, screenshots): real input into a guest page and
// fixture pages for the four frameworks' dev-build metadata.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import type { BrowserObservation } from '../src/shared/test-hooks.js';
import { expect } from './sessions.js';

/** The session's browser as the main process sees it (development test hook). */
export async function observe(
  app: ElectronApplication,
  sessionId: string,
): Promise<BrowserObservation> {
  return app.evaluate(async (_electron, id) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
    return hooks.browser(id);
  }, sessionId);
}

/** Opens the preview tool and loads `address` in the user's tab. */
export async function openPage(page: Page, address: string, title: string | RegExp): Promise<void> {
  if (!(await page.getByTestId('tile-preview').isVisible())) {
    await page.getByTestId('tool-preview').click();
  }
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
  await expect(page.getByTestId('browser-tab').first()).toHaveText(title);
}

/**
 * Clicks the element `selector` of the guest page whose address contains `urlPart` through the
 * page's input pipeline (`webContents.sendInputEvent`): what a real click does. The element's
 * center comes from the page; the click itself is not a DOM event the page could make.
 */
export async function clickInPage(
  app: ElectronApplication,
  urlPart: string,
  selector: string,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((each) => !each.isDestroyed() && each.getURL().includes(args.urlPart));
      if (contents === undefined) throw new Error(`No page at ${args.urlPart}`);
      const center: unknown = await contents.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(args.selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
      if (!Array.isArray(center)) throw new Error('No element');
      const [x, y] = center.map((value) => Math.round(Number(value)));
      if (x === undefined || y === undefined) throw new Error('No element');
      contents.focus();
      contents.sendInputEvent({ type: 'mouseMove', x, y });
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { urlPart, selector },
  );
}

/** Runs `script` in the page's own world (what page code could do). */
export async function inPage(
  app: ElectronApplication,
  urlPart: string,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((each) => !each.isDestroyed() && each.getURL().includes(args.urlPart));
      if (contents === undefined) throw new Error(`No page at ${args.urlPart}`);
      const value: unknown = await contents.executeJavaScript(args.script);
      return value;
    },
    { urlPart, script },
  );
}

/** A served page that sets one element's metadata the way a framework's dev build does. */
export interface FrameworkFixture {
  readonly name: string;
  /** Path → body; `/` is the page. */
  readonly files: (
    workspace: string,
  ) => Record<string, { readonly type: string; readonly body: string }>;
  /** The card's source text the picker must show. */
  readonly source: string;
  /** The innermost component name. */
  readonly component: string;
}

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';

/** The React 19 `src/App.tsx` module as Vite serves it: line 3 creates the button. */
const REACT19_MODULE = [
  'import { jsxDEV } from "/react-dev.js";',
  'export function App() {',
  '  return jsxDEV("button", { id: "target" });',
  '}',
].join('\n');

function base64(text: string): string {
  return Buffer.from(text).toString('base64');
}

export const FRAMEWORK_FIXTURES: readonly FrameworkFixture[] = [
  {
    name: 'React 18 (_debugSource)',
    component: 'Toolbar',
    source: 'src/App.tsx:12:7',
    files: (workspace) => ({
      '/': {
        type: HTML,
        body: `<!doctype html><title>React 18</title><main><button id="target">Save</button></main><script>
function Toolbar() {}
function App() {}
const button = document.getElementById('target');
button['__reactFiber$x1'] = {
  type: 'button',
  _debugSource: { fileName: ${JSON.stringify(`${workspace}/src/App.tsx`)}, lineNumber: 12, columnNumber: 7 },
  return: { type: Toolbar, return: { type: App, return: null } },
};
</script>`,
      },
    }),
  },
  {
    name: 'React 19 (_debugStack and a same-origin source map)',
    component: 'App',
    // The map moves every served line down by 10: served line 3 is original line 13.
    source: 'src/App.tsx:13:1',
    files: () => ({
      '/': {
        type: HTML,
        body: `<!doctype html><title>React 19</title><main id="root"></main><script type="module">
import { App } from '/src/App.tsx';
import { render } from '/react-dev.js';
render(App, document.getElementById('root'));
</script>`,
      },
      '/react-dev.js': {
        type: JS,
        body: `export function jsxDEV(type, props) {
  const element = document.createElement(type);
  element.id = props.id;
  element.textContent = 'Save';
  element['__reactFiber$x2'] = { type, _debugStack: new Error('react-stack-top-frame'), return: { type: current, return: null } };
  return element;
}
let current;
function react_stack_bottom_frame(component) { current = component; return component(); }
export function render(component, root) { root.append(react_stack_bottom_frame(component)); }`,
      },
      '/src/App.tsx': {
        type: JS,
        body: `${REACT19_MODULE}\n//# sourceMappingURL=data:application/json;base64,${base64(
          JSON.stringify({ version: 3, sources: ['App.tsx'], mappings: 'AAUA;AACA;AACA;AACA' }),
        )}`,
      },
    }),
  },
  {
    name: 'Vue (__file)',
    component: 'HelloCard',
    source: 'src/components/HelloCard.vue',
    files: (workspace) => ({
      '/': {
        type: HTML,
        body: `<!doctype html><title>Vue</title><main><button id="target">Save</button></main><script>
document.getElementById('target').__vueParentComponent = {
  type: { __name: 'HelloCard', __file: ${JSON.stringify(`${workspace}/src/components/HelloCard.vue`)} },
  parent: { type: { name: 'App', __file: ${JSON.stringify(`${workspace}/src/App.vue`)} }, parent: null },
};
</script>`,
      },
    }),
  },
  {
    name: 'Svelte (__svelte_meta)',
    component: 'App',
    source: 'src/App.svelte:7:3',
    files: () => ({
      '/': {
        type: HTML,
        body: `<!doctype html><title>Svelte</title><main><button id="target">Save</button></main><script>
document.getElementById('target').__svelte_meta = { parent: null, loc: { file: 'src/App.svelte', line: 7, column: 3 } };
</script>`,
      },
    }),
  },
];

/** The workspace files the fixtures' source locations point at. */
export const SOURCE_FILES: Record<string, string> = {
  'src/App.tsx': '// line\n'.repeat(20),
  'src/App.vue': '<template><HelloCard /></template>\n',
  'src/components/HelloCard.vue': '<template><button>Save</button></template>\n',
  'src/App.svelte': '<!-- line -->\n'.repeat(10),
};

/** Serves `files` (path → content type and body) on a loopback port until `close`. */
export async function serve(
  files: Record<string, { readonly type: string; readonly body: string }>,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const file = files[(request.url ?? '/').split('?')[0] ?? '/'];
    if (file === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': file.type }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Lets the test model take images (the attachments go to it as image blocks). */
export async function acceptImages(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, 'pi', 'models.json');
  const models = JSON.parse(await readFile(file, 'utf8')) as {
    providers: Record<string, { models: { input: string[] }[] }>;
  };
  for (const provider of Object.values(models.providers)) {
    for (const model of provider.models) model.input = ['text', 'image'];
  }
  await writeFile(file, JSON.stringify(models));
}

/** Replaces native menus with a recorder: the page menu's items can then be run (B1.3.8). */
export async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const store = globalThis as { __piarcMenus?: unknown[][] };
    store.__piarcMenus = [];
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      store.__piarcMenus?.push(template);
      const menu = build(template);
      menu.popup = () => undefined;
      return menu;
    };
  });
}

/** Runs the item labelled `label` of the last recorded menu. */
export async function runMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_electron, wanted) => {
    const store = globalThis as { __piarcMenus?: { label?: string; click?: () => void }[][] };
    const item = store.__piarcMenus?.at(-1)?.find((entry) => entry.label === wanted);
    if (item?.click === undefined) throw new Error(`No menu item ${wanted}`);
    item.click();
  }, label);
}

/** A right click in the guest page at the center of `selector` (opens the page menu). */
export async function rightClickInPage(
  app: ElectronApplication,
  urlPart: string,
  selector: string,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((each) => !each.isDestroyed() && each.getURL().includes(args.urlPart));
      if (contents === undefined) throw new Error(`No page at ${args.urlPart}`);
      const center: unknown = await contents.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(args.selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
      if (!Array.isArray(center)) throw new Error('No element');
      const [x, y] = center.map((value) => Math.round(Number(value)));
      if (x === undefined || y === undefined) throw new Error('No element');
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    },
    { urlPart, selector },
  );
}
