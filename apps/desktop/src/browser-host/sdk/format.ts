// Ported from ego-browser package/ego-browser/src/format.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: node:util `inspect` (depth 6, one line, compact) is replaced by a local
// formatter that prints the same shapes for the values scripts log.

const MAX_DEPTH = 6;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function formatCliLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return inspectValue(value);
}

/** One-line rendering in the style of Node's `util.inspect(value, { compact: true })`. */
export function inspectValue(value: unknown): string {
  return formatValue(value, 0, new Map());
}

function formatValue(value: unknown, depth: number, seen: Map<object, number>): string {
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint':
      return `${String(value)}n`;
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return formatFunction(value);
    case 'object':
      return value === null ? 'null' : formatObject(value, depth, seen);
  }
}

function formatFunction(value: object): string {
  const source = Function.prototype.toString.call(value);
  const ownName: unknown = Reflect.get(value, 'name');
  const name = typeof ownName === 'string' ? ownName : '';
  if (source.startsWith('class')) {
    return name ? `[class ${name}]` : '[class (anonymous)]';
  }
  return name ? `[Function: ${name}]` : '[Function (anonymous)]';
}

function formatObject(value: object, depth: number, seen: Map<object, number>): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (seen.has(value)) {
    return '[Circular *1]';
  }
  if (depth > MAX_DEPTH) {
    return Array.isArray(value) ? '[Array]' : `[${constructorName(value) ?? 'Object'}]`;
  }
  seen.set(value, depth);
  try {
    const next = (item: unknown) => formatValue(item, depth + 1, seen);
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return items.length === 0 ? '[]' : `[ ${items.map(next).join(', ')} ]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([key, item]) => `${next(key)} => ${next(item)}`);
      return `Map(${String(value.size)}) ${braces(entries)}`;
    }
    if (value instanceof Set) {
      return `Set(${String(value.size)}) ${braces([...value.values()].map(next))}`;
    }
    if (value instanceof Promise) {
      return 'Promise { <pending> }';
    }
    const entries = Object.entries(value).map(([key, item]) => `${formatKey(key)}: ${next(item)}`);
    const name = constructorName(value);
    const prefix =
      name === undefined ? '[Object: null prototype] ' : name === 'Object' ? '' : `${name} `;
    return `${prefix}${braces(entries)}`;
  } finally {
    seen.delete(value);
  }
}

function constructorName(value: object): string | undefined {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return undefined;
  const ctor: unknown = (proto as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'Object';
}

function braces(entries: readonly string[]): string {
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function formatKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quote(key);
}

function quote(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (!escaped.includes("'")) return `'${escaped}'`;
  if (!escaped.includes('"')) return `"${escaped}"`;
  if (!escaped.includes('`')) return `\`${escaped}\``;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}
