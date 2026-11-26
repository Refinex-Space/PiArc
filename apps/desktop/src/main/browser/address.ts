// What the user typed into the browser's address bar (B1.2.2): a URL, a local file, a search,
// or something refused. The renderer sends what was typed; only the main process decides.

import { BROWSER_LIMITS } from '../../shared/browser.js';

export type ParsedAddress =
  | { readonly kind: 'url'; readonly url: string }
  /** A path as typed (absolute, `~/`, `./` or `../`); the main process resolves it. */
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'search'; readonly query: string }
  | {
      readonly kind: 'refused';
      readonly reason: 'empty' | 'tooLong' | 'credentials' | 'scheme' | 'invalid';
    };

/** Search engines the user can pick (B5.5). */
export const SEARCH_ENGINES = ['google', 'bing', 'duckduckgo', 'baidu'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

const SEARCH_URLS: Readonly<Record<SearchEngine, string>> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

/** The search page of `engine` for `query`. */
export function searchUrl(engine: SearchEngine, query: string): string {
  return SEARCH_URLS[engine] + encodeURIComponent(query);
}

/** Top-level domains that never resolve publicly, so they load over plain HTTP. */
const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.lan', '.home.arpa'];

const HOST_PORT = /^(\[[0-9a-f:.]+\]|[^\s/:?#[\]@]+):(\d{1,5})(?=$|[/?#])/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+[a-z\u00a1-\uffff][a-z0-9\u00a1-\uffff-]{0,62}$/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/** Parses what the user typed. */
export function parseAddress(typed: string): ParsedAddress {
  const input = typed.trim();
  if (input.length === 0) return { kind: 'refused', reason: 'empty' };
  if (input.length > BROWSER_LIMITS.input) return { kind: 'refused', reason: 'tooLong' };
  if (isPath(input)) return { kind: 'file', path: input };
  if (input.startsWith(':') && /^:\d{1,5}(?=$|[/?#])/.test(input)) {
    return web(`http://localhost${input}`);
  }
  const hostPort = HOST_PORT.exec(input);
  if (hostPort !== null && !SCHEME.test(input.replace(HOST_PORT, ''))) {
    return web(`${local(hostPort[1] ?? '') ? 'http' : 'https'}://${input}`);
  }
  const scheme = SCHEME.exec(input)?.[1]?.toLowerCase();
  if (scheme !== undefined && !/\s/.test(input)) {
    if (scheme === 'http' || scheme === 'https') return web(input);
    if (scheme === 'file') return fileUrl(input);
    if (input.toLowerCase() === 'about:blank') return { kind: 'url', url: 'about:blank' };
    return { kind: 'refused', reason: 'scheme' };
  }
  if (/\s/.test(input)) return { kind: 'search', query: input };
  const host = hostOf(input);
  if (local(host)) return web(`http://${input}`);
  if (IPV4.test(host) || DOMAIN.test(host)) return web(`https://${input}`);
  return { kind: 'search', query: input };
}

/** Whether `host` is this machine or a name that never leaves the local network. */
export function local(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true;
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (!IPV4.test(name)) return false;
  const [a = 0, b = 0] = name.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function isPath(input: string): boolean {
  return (
    input.startsWith('/') ||
    input.startsWith('~/') ||
    input === '~' ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    WINDOWS_DRIVE.test(input)
  );
}

function hostOf(input: string): string {
  const end = input.search(/[/?#]/);
  return (end === -1 ? input : input.slice(0, end)).toLowerCase();
}

function web(text: string): ParsedAddress {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'refused', reason: 'invalid' };
  }
  if (url.username !== '' || url.password !== '') return { kind: 'refused', reason: 'credentials' };
  if (url.hostname === '') return { kind: 'refused', reason: 'invalid' };
  return { kind: 'url', url: url.href };
}

function fileUrl(text: string): ParsedAddress {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'refused', reason: 'invalid' };
  }
  if (url.host !== '') return { kind: 'refused', reason: 'scheme' };
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return { kind: 'refused', reason: 'invalid' };
  }
  // `file:///C:/x` has the path `/C:/x`.
  return { kind: 'file', path: /^\/[a-z]:\//i.test(path) ? path.slice(1) : path };
}
