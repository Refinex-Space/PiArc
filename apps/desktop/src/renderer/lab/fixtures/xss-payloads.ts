// XSS payloads for the transcript (architecture section 10.3: model output is untrusted). Each
// payload, if it ever ran, would overwrite `window.__piarcXssSentinel` with its id; tests set the
// sentinel first and check that it is unchanged, that no element the payload asks for exists in
// the rendered transcript, and that the payload's text is shown literally.

/** Value tests store in `window.__piarcXssSentinel` before rendering the payloads. */
export const XSS_SENTINEL_UNTOUCHED = 'untouched';

/** One payload: Markdown as a model might produce it. */
export interface XssPayload {
  /** Stable id; also the value the payload would write into the sentinel. */
  readonly id: string;
  /** What the payload tries. */
  readonly description: string;
  /** The Markdown source. */
  readonly markdown: string;
  /** Text that must appear literally in the rendered message (the raw markup). */
  readonly visibleText: string;
}

function sentinel(id: string): string {
  return `window.__piarcXssSentinel='${id}'`;
}

/** The payload set; each entry is rendered as its own message and as part of one long message. */
export const XSS_PAYLOADS: readonly XssPayload[] = [
  {
    id: 'script-block',
    description: '<script> as an HTML block',
    markdown: `<script>${sentinel('script-block')}</script>`,
    visibleText: `<script>${sentinel('script-block')}</script>`,
  },
  {
    id: 'script-inline',
    description: '<script> inside a paragraph',
    markdown: `Before <script>${sentinel('script-inline')}</script> after.`,
    visibleText: `<script>${sentinel('script-inline')}</script>`,
  },
  {
    id: 'img-onerror',
    description: 'inline event attribute on an <img>',
    markdown: `<img src="x" onerror="${sentinel('img-onerror')}">`,
    visibleText: `<img src="x" onerror="${sentinel('img-onerror')}">`,
  },
  {
    id: 'div-onmouseover',
    description: 'inline event attribute on a block element',
    markdown: `<div onmouseover="${sentinel('div-onmouseover')}">hover me</div>`,
    visibleText: `<div onmouseover="${sentinel('div-onmouseover')}">hover me</div>`,
  },
  {
    id: 'link-javascript',
    description: 'Markdown link to a javascript: URL',
    markdown: `[click me](javascript:${sentinel('link-javascript')})`,
    visibleText: 'click me',
  },
  {
    id: 'link-javascript-entity',
    description: 'javascript: URL hidden behind a character reference',
    markdown: `[encoded](&#106;avascript:${sentinel('link-javascript-entity')})`,
    visibleText: 'encoded',
  },
  {
    id: 'autolink-javascript',
    description: 'autolink with a javascript: URL',
    markdown: `<javascript:${sentinel('autolink-javascript')}>`,
    visibleText: `javascript:${sentinel('autolink-javascript')}`,
  },
  {
    id: 'anchor-javascript',
    description: 'raw <a> with a javascript: href',
    markdown: `<a href="javascript:${sentinel('anchor-javascript')}">raw anchor</a>`,
    visibleText: `<a href="javascript:${sentinel('anchor-javascript')}">`,
  },
  {
    id: 'svg-script',
    description: 'SVG carrying a <script>',
    markdown: `<svg xmlns="http://www.w3.org/2000/svg"><script>${sentinel('svg-script')}</script></svg>`,
    visibleText: `<svg xmlns="http://www.w3.org/2000/svg"><script>${sentinel('svg-script')}</script></svg>`,
  },
  {
    id: 'svg-onload',
    description: 'SVG with an onload attribute',
    markdown: `<svg onload="${sentinel('svg-onload')}"></svg>`,
    visibleText: `<svg onload="${sentinel('svg-onload')}"></svg>`,
  },
  {
    id: 'iframe-src',
    description: '<iframe> with a javascript: source',
    markdown: `<iframe src="javascript:${sentinel('iframe-src')}"></iframe>`,
    visibleText: `<iframe src="javascript:${sentinel('iframe-src')}"></iframe>`,
  },
  {
    id: 'iframe-srcdoc',
    description: '<iframe> with an inline document',
    markdown: `<iframe srcdoc="<script>parent.${sentinel('iframe-srcdoc')}</script>"></iframe>`,
    visibleText: `<iframe srcdoc="<script>parent.${sentinel('iframe-srcdoc')}</script>"></iframe>`,
  },
  {
    id: 'style-block',
    description: '<style> that would hide the page',
    markdown: '<style>body { display: none !important; }</style>',
    visibleText: '<style>body { display: none !important; }</style>',
  },
  {
    id: 'object-embed',
    description: '<object> and <embed>',
    markdown: '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
    visibleText: '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
  },
  {
    id: 'meta-refresh',
    description: '<meta> refresh to another page',
    markdown: '<meta http-equiv="refresh" content="0; url=https://example.com/">',
    visibleText: '<meta http-equiv="refresh" content="0; url=https://example.com/">',
  },
  {
    id: 'image-data-html',
    description: 'image whose source is an HTML data URL',
    markdown: '![payload](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    visibleText: 'payload',
  },
  {
    id: 'image-remote',
    description: 'remote image (must not load)',
    markdown: '![tracking pixel](https://example.com/pixel.png "title")',
    visibleText: 'tracking pixel',
  },
  {
    id: 'form-action',
    description: '<form> posting elsewhere',
    markdown: '<form action="https://example.com/"><button>submit</button></form>',
    visibleText: '<form action="https://example.com/"><button>submit</button></form>',
  },
];

/** All payloads as one Markdown message, separated by blank lines. */
export function xssMessage(): string {
  return XSS_PAYLOADS.map((payload) => payload.markdown).join('\n\n');
}

/** Tag names none of the payloads may produce inside the rendered transcript. */
export const FORBIDDEN_TAGS: readonly string[] = [
  'script',
  'iframe',
  'style',
  'svg',
  'object',
  'embed',
  'meta',
  'form',
  'img',
  'link',
  'base',
];

declare global {
  /** Overwritten by an XSS payload that ran; see `XSS_SENTINEL_UNTOUCHED`. */
  var __piarcXssSentinel: string | undefined;
}
