// What the picker tells about one element (design addendum B3.2): a unique CSS selector, an
// XPath, the accessible role and name, allow-listed attributes, its text, its markup without
// scripts, event attributes or password values, the computed styles that differ from the
// defaults, its box, the component chain and where its code is.
//
// Two functions run in the page through CDP (`Runtime.callFunctionOn` on the picked node): the
// DOM facts in an isolated world when the node is in the top document (the page's scripts cannot
// change what they read), the framework facts in the page's own world (React, Vue and Svelte keep
// them on the DOM nodes there). Both answers are page data: every field is checked and cut here,
// and a source file counts only when its real path is inside the session's workspace. Nothing the
// page returns is run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_CONTEXT_LIMITS,
  ELEMENT_INFO,
  type BrowserElementContext,
  type BrowserSourceLocation,
} from '../../shared/browser.js';
import { originOf } from '../security/origin.js';
import {
  MAX_STACK,
  mapSource,
  originalPosition,
  parseSourceMap,
  sourceMappingUrl,
  usageFrame,
} from './source-map.js';

// ---------------------------------------------------------------------------------------------
// Page functions

/** Computed style properties the picker reads, in the order they are reported. */
export const STYLE_PROPERTIES = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'width',
  'height',
  'min-width',
  'max-width',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-radius',
  'background-color',
  'background-image',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'letter-spacing',
  'white-space',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'overflow-x',
  'overflow-y',
  'opacity',
  'box-shadow',
  'transform',
  'cursor',
  'visibility',
] as const;

/**
 * The DOM facts of `this` element (`Runtime.callFunctionOn`, isolated world when possible). The
 * markup is serialized from a copy in an inert document, so custom elements of the page are not
 * constructed again.
 */
export const ELEMENT_FACTS = `function (limits) {
  const el = this;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const rootNode = el.getRootNode();
  const scope = rootNode && typeof rootNode.querySelectorAll === 'function' ? rootNode : doc;
  const tagOf = (node) => String(node.localName || node.nodeName || '').toLowerCase();
  const esc = (value) =>
    win && win.CSS && typeof win.CSS.escape === 'function'
      ? win.CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c.codePointAt(0).toString(16) + ' ');
  const quote = (value) => '"' + String(value).replace(/["\\\\]/g, '\\\\$&') + '"';
  const unique = (selector) => {
    try {
      return scope.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  };
  const stableClass = (name) =>
    /^[a-zA-Z][\\w-]{1,40}$/.test(name) && !/\\d{3,}|[a-f0-9]{6,}|^(css|sc|jsx|svelte)-|^_/.test(name);
  const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
  const sameTag = (node) =>
    node.parentElement ? [...node.parentElement.children].filter((c) => tagOf(c) === tagOf(node)) : [node];
  const own = (node) => {
    if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id) && unique('#' + esc(node.id))) {
      return { text: '#' + esc(node.id), unique: true };
    }
    for (const name of TEST_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value && value.length <= 100) {
        const text = tagOf(node) + '[' + name + '=' + quote(value) + ']';
        if (unique(text)) return { text, unique: true };
      }
    }
    let text = tagOf(node);
    const classes = [...node.classList].filter(stableClass).slice(0, 2);
    text += classes.map((c) => '.' + esc(c)).join('');
    const same = sameTag(node);
    if (same.length > 1) text += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    return { text, unique: false };
  };
  const selector = () => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 16; depth += 1) {
      const part = own(node);
      parts.unshift(part.text);
      const joined = parts.join(' > ');
      if (part.unique || unique(joined)) return joined;
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const xpath = () => {
    const steps = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (
        node.id &&
        /^[A-Za-z][\\w-]*$/.test(node.id) &&
        node.getRootNode() === doc &&
        doc.querySelectorAll('#' + esc(node.id)).length === 1
      ) {
        steps.unshift('//*[@id="' + node.id + '"]');
        return steps.join('/');
      }
      const name = tagOf(node);
      let step = node.namespaceURI === 'http://www.w3.org/1999/xhtml' ? name : '*[name()="' + name + '"]';
      const same = sameTag(node);
      if (same.length > 1) step += '[' + (same.indexOf(node) + 1) + ']';
      steps.unshift(step);
      node = node.parentElement;
    }
    return '/' + steps.join('/');
  };
  const ALLOWED = /^(id|class|name|type|role|href|src|alt|title|placeholder|for|lang|dir|aria-[a-z-]+|data-(testid|test|test-id|cy|qa))$/;
  const SCRIPT_URL = /^\\s*(javascript|vbscript|data):/i;
  const attributes = {};
  let kept = 0;
  for (const attribute of [...el.attributes]) {
    if (kept >= limits.attributes) break;
    if (!ALLOWED.test(attribute.name)) continue;
    let value = attribute.value;
    if ((attribute.name === 'href' || attribute.name === 'src') && SCRIPT_URL.test(value)) {
      value = value.trim().split(':')[0] + ':';
    }
    attributes[attribute.name] = value.slice(0, limits.attribute);
    kept += 1;
  }
  const rendered = typeof el.innerText === 'string' && el.innerText !== '' ? el.innerText : el.textContent || '';
  const text = rendered.replace(/\\s+/g, ' ').trim().slice(0, limits.text);
  let html = '';
  if (tagOf(el) !== 'script') {
    const inert = doc.implementation.createHTMLDocument('');
    const copy = inert.importNode(el, true);
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      if (node !== copy && tagOf(node) === 'script') {
        node.remove();
        continue;
      }
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const url = /^(href|src|action|formaction|xlink:href)$/.test(name);
        if (name.startsWith('on') || name === 'srcdoc' || (url && /^\\s*(javascript|vbscript):/i.test(attribute.value))) {
          node.removeAttribute(attribute.name);
        } else if (attribute.value.length > limits.attribute) {
          node.setAttribute(attribute.name, attribute.value.slice(0, limits.attribute) + '…');
        }
      }
      if (tagOf(node) === 'input' && node.hasAttribute('value')) {
        const type = String(node.getAttribute('type') || '').toLowerCase();
        const complete = String(node.getAttribute('autocomplete') || '').toLowerCase();
        if (type === 'password' || type === 'hidden' || complete.includes('password')) {
          node.setAttribute('value', '••••');
        }
      }
    }
    html = copy.outerHTML.slice(0, limits.html);
  }
  const read = (node) => {
    const out = {};
    if (!node || !win || typeof win.getComputedStyle !== 'function') return out;
    const style = win.getComputedStyle(node);
    for (const name of limits.styles) out[name] = String(style.getPropertyValue(name) || '');
    return out;
  };
  const rect = el.getBoundingClientRect();
  return {
    tag: tagOf(el),
    selector: selector(),
    xpath: xpath(),
    attributes,
    text,
    html,
    styles: { self: read(el), parent: read(el.parentElement) },
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    dpr: win ? win.devicePixelRatio : 1,
  };
}`;

/** The page-side limits `ELEMENT_FACTS` takes (wider than the final ones; cut again here). */
export const FACT_LIMITS = {
  attributes: 24,
  attribute: 200,
  text: BROWSER_CONTEXT_LIMITS.text + 1,
  html: BROWSER_CONTEXT_LIMITS.html * 2,
  styles: STYLE_PROPERTIES,
} as const;

/**
 * The framework facts of `this` element in the page's own world: React fibers
 * (`__reactFiber$…`), Vue 3 (`__vueParentComponent`) and Vue 2 (`__vue__`) instances, Svelte's
 * `__svelte_meta`. Component names innermost first; React 18's `_debugSource`, React 19's
 * `_debugStack` text, Vue's `__file`, Svelte's location.
 */
export const FRAMEWORK_FACTS = `function () {
  const el = this;
  const MAX = ${String(BROWSER_CONTEXT_LIMITS.components)};
  const str = (value, max) => (typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined);
  const baseName = (file) => {
    const name = String(file).split(/[\\\\/]/).pop() || '';
    return str(name.replace(/\\.[a-z]+$/i, ''), 100);
  };
  const typeName = (type, depth) => {
    if (!type || depth > 3) return undefined;
    if (typeof type === 'function') return str(type.displayName, 100) || str(type.name, 100);
    if (typeof type === 'object') {
      return str(type.displayName, 100) || typeName(type.render, depth + 1) || typeName(type.type, depth + 1);
    }
    return undefined;
  };
  let key;
  try {
    key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  } catch (error) {
    key = undefined;
  }
  if (key) {
    const host = el[key];
    const components = [];
    for (let fiber = host, i = 0; fiber && i < 200 && components.length < MAX; fiber = fiber.return, i += 1) {
      if (typeof fiber.type === 'string') continue;
      const name = typeName(fiber.type, 0);
      if (name && components[components.length - 1] !== name) components.push(name);
    }
    let source;
    let stack;
    for (let fiber = host, i = 0; fiber && i < 50; fiber = fiber.return, i += 1) {
      const debug = fiber._debugSource;
      if (debug && typeof debug.fileName === 'string') {
        source = { file: debug.fileName.slice(0, 2048), line: debug.lineNumber, column: debug.columnNumber };
        break;
      }
      const error = fiber._debugStack;
      if (error && typeof error.stack === 'string') {
        stack = error.stack.slice(0, ${String(MAX_STACK)});
        break;
      }
    }
    return { framework: 'react', components, source, stack };
  }
  const vue = el.__vueParentComponent;
  if (vue) {
    const components = [];
    let file;
    for (let instance = vue, i = 0; instance && i < 50; instance = instance.parent, i += 1) {
      const type = instance.type || {};
      const name = str(type.name, 100) || str(type.__name, 100) || (typeof type.__file === 'string' ? baseName(type.__file) : undefined);
      if (name && components.length < MAX) components.push(name);
      if (file === undefined && typeof type.__file === 'string') file = type.__file.slice(0, 2048);
    }
    return { framework: 'vue', components, source: file === undefined ? undefined : { file } };
  }
  const vue2 = el.__vue__;
  if (vue2) {
    const components = [];
    let file;
    for (let instance = vue2, i = 0; instance && i < 50; instance = instance.$parent, i += 1) {
      const options = instance.$options || {};
      const name = str(options.name, 100) || str(options._componentTag, 100);
      if (name && components.length < MAX) components.push(name);
      if (file === undefined && typeof options.__file === 'string') file = options.__file.slice(0, 2048);
    }
    return { framework: 'vue', components, source: file === undefined ? undefined : { file } };
  }
  const meta = el.__svelte_meta;
  if (meta && meta.loc && typeof meta.loc.file === 'string') {
    const components = [];
    for (let parent = meta.parent, i = 0; parent && i < 50 && components.length < MAX; parent = parent.parent, i += 1) {
      const tag = str(parent.componentTag, 100);
      if (parent.type === 'component' && tag) components.push(tag);
    }
    if (components.length === 0) {
      const name = baseName(meta.loc.file);
      if (name) components.push(name);
    }
    return {
      framework: 'svelte',
      components,
      source: {
        file: meta.loc.file.slice(0, 2048),
        line: meta.loc.line,
        column: meta.loc.column,
        zeroBased: typeof meta.loc.char === 'number',
      },
    };
  }
  return { framework: '', components: [] };
}`;

// ---------------------------------------------------------------------------------------------
// Narrowing the page's answers

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The DOM facts as checked data. */
export interface ElementFacts {
  readonly tag: string;
  readonly selector: string;
  readonly xpath: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string;
  readonly html: string;
  readonly self: Readonly<Record<string, string>>;
  readonly parent: Readonly<Record<string, string>>;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly dpr: number;
}

function strings(value: unknown, names: readonly string[], max: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const name of names) {
    const entry = value[name];
    if (typeof entry === 'string') out[name] = entry.slice(0, max);
  }
  return out;
}

const ATTRIBUTE_NAME =
  /^(?:id|class|name|type|role|href|src|alt|title|placeholder|for|lang|dir|aria-[a-z-]{1,40}|data-(?:testid|test|test-id|cy|qa))$/u;

/** The answer of `ELEMENT_FACTS`, checked; `undefined` when it is not one. */
export function parseFacts(value: unknown): ElementFacts | undefined {
  if (!isRecord(value) || typeof value.tag !== 'string' || typeof value.selector !== 'string') {
    return undefined;
  }
  const attributes: Record<string, string> = {};
  if (isRecord(value.attributes)) {
    for (const [name, entry] of Object.entries(value.attributes).slice(0, FACT_LIMITS.attributes)) {
      if (ATTRIBUTE_NAME.test(name) && typeof entry === 'string') {
        attributes[name] = entry.slice(0, FACT_LIMITS.attribute);
      }
    }
  }
  const styles = isRecord(value.styles) ? value.styles : {};
  const box = isRecord(value.box) ? value.box : {};
  const dpr = finite(value.dpr);
  return {
    tag: text(value.tag, 64),
    selector: text(value.selector, 2048),
    xpath: text(value.xpath, 2048),
    attributes,
    text: text(value.text, FACT_LIMITS.text),
    html: text(value.html, FACT_LIMITS.html),
    self: strings(styles.self, STYLE_PROPERTIES, 300),
    parent: strings(styles.parent, STYLE_PROPERTIES, 300),
    box: {
      x: finite(box.x),
      y: finite(box.y),
      width: Math.max(0, finite(box.width)),
      height: Math.max(0, finite(box.height)),
    },
    dpr: dpr >= 0.25 && dpr <= 8 ? dpr : 1,
  };
}

/** Where the page says an element's code is, before it is checked against the workspace. */
export interface RawSource {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/** The framework facts as checked data. */
export interface FrameworkFacts {
  readonly framework: 'react' | 'vue' | 'svelte' | '';
  readonly components: readonly string[];
  readonly source?: RawSource;
  /** React 19's `_debugStack` text. */
  readonly stack?: string;
}

/** A positive whole number up to ten million, or `undefined`. */
function position(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1e7
    ? value
    : undefined;
}

/** The answer of `FRAMEWORK_FACTS`, checked; frameworks it does not know become `''`. */
export function parseFramework(value: unknown): FrameworkFacts {
  if (!isRecord(value)) return { framework: '', components: [] };
  const framework =
    value.framework === 'react' || value.framework === 'vue' || value.framework === 'svelte'
      ? value.framework
      : '';
  const components = Array.isArray(value.components)
    ? value.components
        .filter((name): name is string => typeof name === 'string')
        .map((name) =>
          name
            .replace(/[\p{Cc}]/gu, '')
            .trim()
            .slice(0, 100),
        )
        .filter((name) => name !== '')
        .slice(0, BROWSER_CONTEXT_LIMITS.components)
    : [];
  let source: RawSource | undefined;
  const raw = value.source;
  if (
    isRecord(raw) &&
    typeof raw.file === 'string' &&
    raw.file !== '' &&
    !raw.file.includes('\0')
  ) {
    // Svelte 3 and 4 count lines and columns from 0 (their meta carries `char`), Svelte 5 from 1.
    const shift = raw.zeroBased === true ? 1 : 0;
    const line = position(typeof raw.line === 'number' ? raw.line + shift : undefined);
    const column = position(typeof raw.column === 'number' ? raw.column + shift : undefined);
    source = {
      file: raw.file.slice(0, 2048),
      ...(line === undefined ? {} : { line }),
      ...(line === undefined || column === undefined ? {} : { column }),
    };
  }
  const stack = typeof value.stack === 'string' ? value.stack.slice(0, MAX_STACK) : undefined;
  return {
    framework,
    components,
    ...(source === undefined ? {} : { source }),
    ...(stack === undefined || source !== undefined ? {} : { stack }),
  };
}

// ---------------------------------------------------------------------------------------------
// Shaping the context

/** `value` cut to at most `max` UTF-8 bytes on a character boundary, with `…` when cut. */
export function capBytes(value: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= max) return value;
  const room = max - encoder.encode('…').length;
  let used = 0;
  let out = '';
  for (const ch of value) {
    const size = encoder.encode(ch).length;
    if (used + size > room) break;
    used += size;
    out += ch;
  }
  return `${out}…`;
}

/** `value` cut to at most `max` characters (code points), with `…` when cut. */
export function capChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/** The display value of an element's tag when no style says otherwise (Chromium's UA sheet). */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'search',
  'section',
  'summary',
  'ul',
]);

const DEFAULT_DISPLAY: Readonly<Record<string, string>> = {
  li: 'list-item',
  table: 'table',
  tr: 'table-row',
  td: 'table-cell',
  th: 'table-cell',
  thead: 'table-header-group',
  tbody: 'table-row-group',
  tfoot: 'table-footer-group',
  button: 'inline-block',
  input: 'inline-block',
  select: 'inline-block',
  textarea: 'inline-block',
  img: 'inline',
};

export function defaultDisplay(tag: string): string {
  return DEFAULT_DISPLAY[tag] ?? (BLOCK_TAGS.has(tag) ? 'block' : 'inline');
}

/** Initial values of the properties that do not inherit (`display` is by tag). */
const INITIAL: Readonly<Record<string, readonly string[]>> = {
  position: ['static'],
  top: ['auto'],
  right: ['auto'],
  bottom: ['auto'],
  left: ['auto'],
  'z-index': ['auto'],
  'min-width': ['auto', '0px'],
  'max-width': ['none'],
  'border-radius': ['0px'],
  'background-color': ['rgba(0, 0, 0, 0)', 'transparent'],
  'background-image': ['none'],
  'flex-direction': ['row'],
  'flex-wrap': ['nowrap'],
  'justify-content': ['normal'],
  'align-items': ['normal'],
  gap: ['normal', 'normal normal'],
  'grid-template-columns': ['none'],
  'overflow-x': ['visible'],
  'overflow-y': ['visible'],
  opacity: ['1'],
  'box-shadow': ['none'],
  transform: ['none'],
  cursor: ['auto'],
};

/** Properties that inherit: they differ from the default when they differ from the parent's. */
const INHERITED = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'letter-spacing',
  'white-space',
  'cursor',
  'visibility',
]);

/** Four sides as one shorthand value (`8px 16px`), or `undefined` when all are `0px`. */
function sides(
  style: Readonly<Record<string, string>>,
  name: 'margin' | 'padding',
): string | undefined {
  const values = ['top', 'right', 'bottom', 'left'].map((side) => style[`${name}-${side}`] ?? '');
  if (values.every((value) => value === '' || value === '0px')) return undefined;
  const [top, right, bottom, left] = values;
  if (top === bottom && right === left) return top === right ? top : `${top ?? ''} ${right ?? ''}`;
  return values.join(' ');
}

/**
 * The panel's information card of an element (`BrowserPick.info`): its computed values as they
 * are, inherited or not; four-sided properties as one shorthand (`0px` when all are zero).
 */
export function elementInfo(self: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ELEMENT_INFO) {
    const value =
      name === 'margin' || name === 'padding'
        ? self[`${name}-top`] === undefined
          ? undefined
          : (sides(self, name) ?? '0px')
        : self[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/**
 * The computed styles of an element that differ from the defaults (B3.2), at most
 * `BROWSER_CONTEXT_LIMITS.styles`, in `STYLE_PROPERTIES` order: inherited properties that differ
 * from the parent's, others that differ from their initial value; four-sided properties as one
 * shorthand. Width and height are in the box already.
 */
export function styleDiff(
  self: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string>>,
  tag: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const positioned = (self.position ?? 'static') !== 'static';
  const flex = (self.display ?? '').includes('flex');
  const grid = (self.display ?? '').includes('grid');
  const add = (name: string, value: string | undefined) => {
    if (
      value === undefined ||
      value === '' ||
      Object.keys(out).length >= BROWSER_CONTEXT_LIMITS.styles
    )
      return;
    out[name] = value;
  };
  for (const name of STYLE_PROPERTIES) {
    const value = self[name];
    if (value === undefined || value === '') continue;
    if (name === 'width' || name === 'height') continue;
    if (name === 'display') {
      if (value !== defaultDisplay(tag)) add(name, value);
    } else if (name.startsWith('margin-') || name.startsWith('padding-')) {
      if (name.endsWith('-top'))
        add(
          name.split('-')[0] ?? name,
          sides(self, name.startsWith('margin') ? 'margin' : 'padding'),
        );
    } else if (name.startsWith('border-top-')) {
      if (name === 'border-top-style' && value !== 'none') {
        add(
          'border',
          `${self['border-top-width'] ?? ''} ${value} ${self['border-top-color'] ?? ''}`.trim(),
        );
      }
    } else if (['top', 'right', 'bottom', 'left', 'z-index'].includes(name)) {
      if (positioned && !(INITIAL[name] ?? []).includes(value)) add(name, value);
    } else if (
      ['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap'].includes(name)
    ) {
      if ((flex || grid) && !(INITIAL[name] ?? []).includes(value)) add(name, value);
    } else if (name === 'grid-template-columns') {
      if (grid && !(INITIAL[name] ?? []).includes(value)) add(name, value);
    } else if (INHERITED.has(name)) {
      if (value !== parent[name]) add(name, value);
    } else if (!(INITIAL[name] ?? []).includes(value)) {
      add(name, value);
    }
  }
  return out;
}

/**
 * The screenshot clip of an element (B3.2): its box with a margin, in page coordinates (CSS
 * pixels), at a scale that keeps the image's longest edge within the limit; `undefined` when the
 * box is empty.
 */
export function elementClip(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  scroll: { readonly x: number; readonly y: number },
  dpr: number,
  content?: { readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number; scale: number } | undefined {
  if (box.width < 1 || box.height < 1) return undefined;
  const margin = BROWSER_CONTEXT_LIMITS.margin;
  const left = Math.max(0, box.x + scroll.x - margin);
  const top = Math.max(0, box.y + scroll.y - margin);
  let right = box.x + scroll.x + box.width + margin;
  let bottom = box.y + scroll.y + box.height + margin;
  if (content !== undefined && content.width > 0 && content.height > 0) {
    right = Math.min(right, Math.max(content.width, left + 1));
    bottom = Math.min(bottom, Math.max(content.height, top + 1));
  }
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const longest = Math.max(width, height) * dpr;
  const scale = Math.min(1, BROWSER_CONTEXT_LIMITS.imageEdge / longest);
  return { x: left, y: top, width, height, scale };
}

// ---------------------------------------------------------------------------------------------
// Source locations

/** What locating a source needs from the outside world. */
export interface SourceIo {
  /** `fs.promises.realpath`. */
  realpath(file: string): Promise<string>;
  /** The text at `url` (same origin as the page; checked by the caller), at most `max` bytes. */
  fetchText(url: string, max: number): Promise<string | undefined>;
}

/** Sizes of what is read to symbolicate a React 19 stack. */
export const SOURCE_FETCH_LIMITS = { script: 8 * 1024 * 1024, map: 24 * 1024 * 1024 } as const;

const BUNDLER_SCHEMES = /^(?:webpack|webpack-internal|rspack|turbopack):\/\/\/?/u;

/** The files on disk `file` may name, most likely first (`root` is the workspace). */
export function sourceCandidates(file: string, pageUrl: string, root: string): string[] {
  const value = file.trim();
  if (value === '' || value.length > 2048 || value.includes('\0')) return [];
  if (/^https?:\/\//iu.test(value)) {
    if (originOf(value) === 'null' || originOf(value) !== originOf(pageUrl)) return [];
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(value).pathname);
    } catch {
      return [];
    }
    // Vite serves files outside its root as `/@fs/<absolute path>`.
    if (pathname.startsWith('/@fs/')) {
      const absolute = pathname.slice(4);
      return [/^\/[a-z]:\//iu.test(absolute) ? absolute.slice(1) : absolute];
    }
    return [path.join(root, pathname)];
  }
  if (/^file:\/\//iu.test(value)) {
    try {
      return [fileURLToPath(value)];
    } catch {
      return [];
    }
  }
  if (BUNDLER_SCHEMES.test(value)) {
    // `webpack://app/./src/App.tsx`, `webpack-internal:///./src/App.tsx`: the path after the
    // namespace is relative to the project.
    const rest = value.replace(BUNDLER_SCHEMES, '').replace(/^[^/.][^/]*\//u, '');
    return [path.join(root, rest.split('?')[0] ?? rest)];
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) return [];
  if (path.isAbsolute(value)) {
    // Also as relative to the project: Vite names modules by their URL path (`/src/App.tsx`).
    return value.startsWith('/') ? [value, path.join(root, value)] : [value];
  }
  return [path.join(root, value)];
}

/**
 * The location of `raw` when its real path is a file inside `root`'s real path (B3.2): relative,
 * with `/`; otherwise `undefined` (the card then shows only the component name).
 */
export async function containedSource(
  raw: RawSource,
  pageUrl: string,
  root: string,
  io: Pick<SourceIo, 'realpath'>,
): Promise<BrowserSourceLocation | undefined> {
  let realRoot: string;
  try {
    realRoot = await io.realpath(root);
  } catch {
    return undefined;
  }
  for (const candidate of sourceCandidates(raw.file, pageUrl, root)) {
    let real: string;
    try {
      real = await io.realpath(candidate);
    } catch {
      continue;
    }
    const relative = path.relative(realRoot, real);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return {
      path: relative.split(path.sep).join('/'),
      ...(raw.line === undefined ? {} : { line: raw.line }),
      ...(raw.line === undefined || raw.column === undefined ? {} : { column: raw.column }),
    };
  }
  return undefined;
}

/** The text of a `data:` URL (base64 or percent-encoded), at most `max` characters. */
export function dataUrlText(url: string, max: number): string | undefined {
  const match = /^data:([^,]*),(.*)$/su.exec(url);
  if (match === null) return undefined;
  const [, meta = '', body = ''] = match;
  if (body.length > max * 2) return undefined;
  try {
    const decoded = /;base64$/iu.test(meta)
      ? Buffer.from(body, 'base64').toString('utf8')
      : decodeURIComponent(body);
    return decoded.length > max ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/** The original position of a React 19 element: the served frame through its source map. */
async function symbolicate(
  stack: string,
  pageUrl: string,
  io: SourceIo,
): Promise<RawSource | undefined> {
  const frame = usageFrame(stack);
  if (frame === undefined) return undefined;
  const served: RawSource = { file: frame.file, line: frame.line, column: frame.column };
  const sameOrigin = (url: string) =>
    originOf(url) !== 'null' && originOf(url) === originOf(pageUrl);
  if (!sameOrigin(frame.file)) return served;
  const code = await io.fetchText(frame.file, SOURCE_FETCH_LIMITS.script);
  const reference = code === undefined ? undefined : sourceMappingUrl(code);
  if (reference === undefined) return served;
  let json: string | undefined;
  let base = frame.file;
  if (reference.startsWith('data:')) {
    json = dataUrlText(reference, SOURCE_FETCH_LIMITS.map);
  } else {
    let url: string;
    try {
      url = new URL(reference, frame.file).toString();
    } catch {
      return served;
    }
    if (!sameOrigin(url)) return served;
    json = await io.fetchText(url, SOURCE_FETCH_LIMITS.map);
    base = url;
  }
  let parsed: unknown;
  try {
    parsed = json === undefined ? undefined : JSON.parse(json);
  } catch {
    return served;
  }
  const map = parseSourceMap(parsed);
  if (map === undefined) return served;
  const original = originalPosition(map, frame.line, frame.column);
  if (original === undefined) return served;
  return {
    file: mapSource(map, original.source, base),
    line: original.line,
    column: original.column,
  };
}

/** Where the element's code is, inside the workspace, or `undefined`. */
export async function locateSource(
  facts: FrameworkFacts,
  pageUrl: string,
  root: string,
  io: SourceIo,
): Promise<BrowserSourceLocation | undefined> {
  const raw =
    facts.source ??
    (facts.stack === undefined ? undefined : await symbolicate(facts.stack, pageUrl, io));
  return raw === undefined ? undefined : containedSource(raw, pageUrl, root, io);
}

/** The element context the panel gets, from the checked facts (B3.2 limits applied). */
export function buildContext(
  url: string,
  facts: ElementFacts,
  framework: FrameworkFacts,
  accessibility: { readonly role: string; readonly name: string },
  box: ElementFacts['box'],
  source: BrowserSourceLocation | undefined,
): BrowserElementContext {
  const html = capBytes(
    facts.html,
    source === undefined ? BROWSER_CONTEXT_LIMITS.html : BROWSER_CONTEXT_LIMITS.htmlWithSource,
  );
  return {
    url: url.slice(0, 2048),
    tag: facts.tag,
    selector: facts.selector,
    xpath: facts.xpath,
    role: capChars(accessibility.role, 64),
    name: capChars(accessibility.name.replace(/\s+/gu, ' ').trim(), BROWSER_CONTEXT_LIMITS.text),
    attributes: facts.attributes,
    text: capChars(facts.text, BROWSER_CONTEXT_LIMITS.text),
    html,
    styles: styleDiff(facts.self, facts.parent, facts.tag),
    box: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
    components: framework.components,
    ...(source === undefined ? {} : { source }),
  };
}
