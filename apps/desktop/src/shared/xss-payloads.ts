// XSS payloads for the transcript (architecture section 10.3: model output is untrusted), shared
// by the renderer's parser tests, the prototype page and the L4 tests. Each
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
  // T45: link schemes, entity obfuscation, SVG events and foreignObject, style url(),
  // markup in file names and Unicode bidirectional controls.
  {
    id: 'link-data-html',
    description: 'Markdown link to an HTML data URL',
    markdown: `[data link](data:text/html,<script>${sentinel('link-data-html')}</script>)`,
    visibleText: 'data link',
  },
  {
    id: 'link-vbscript',
    description: 'Markdown link to a vbscript: URL',
    markdown: '[vb link](vbscript:msgbox(1))',
    visibleText: 'vb link',
  },
  {
    id: 'link-javascript-tab-entity',
    description: 'javascript: split by an encoded tab and newline',
    markdown: `[tabbed](java&#x09;scr&#x0A;ipt:${sentinel('link-javascript-tab-entity')})`,
    visibleText: 'tabbed',
  },
  {
    id: 'anchor-javascript-hex-entity',
    description: 'raw <a> whose javascript: is hex character references',
    markdown: `<a href="&#x6A;&#x61;&#x76;&#x61;script:${sentinel('anchor-javascript-hex-entity')}">hex anchor</a>`,
    visibleText: `<a href="&#x6A;&#x61;&#x76;&#x61;script:${sentinel('anchor-javascript-hex-entity')}">`,
  },
  {
    id: 'svg-foreign-object',
    description: 'SVG foreignObject carrying an <img> with onerror',
    markdown: `<svg><foreignObject><img src="x" onerror="${sentinel('svg-foreign-object')}"></foreignObject></svg>`,
    visibleText: `<svg><foreignObject><img src="x" onerror="${sentinel('svg-foreign-object')}"></foreignObject></svg>`,
  },
  {
    id: 'svg-animate-onbegin',
    description: 'SVG <animate> with an onbegin attribute',
    markdown: `<svg><animate onbegin="${sentinel('svg-animate-onbegin')}" attributeName="x" dur="1s"></animate></svg>`,
    visibleText: `<svg><animate onbegin="${sentinel('svg-animate-onbegin')}" attributeName="x" dur="1s"></animate></svg>`,
  },
  {
    id: 'svg-anchor-xlink',
    description: 'SVG <a> with an xlink:href to javascript:',
    markdown: `<svg><a xlink:href="javascript:${sentinel('svg-anchor-xlink')}"><text>svg link</text></a></svg>`,
    visibleText: `<svg><a xlink:href="javascript:${sentinel('svg-anchor-xlink')}"><text>svg link</text></a></svg>`,
  },
  {
    id: 'style-url',
    description: 'inline style loading a remote url() and a javascript: url()',
    markdown:
      '<div style="background:url(https://example.com/track.png)"><span style="background-image:url(javascript:alert(1))">styled</span></div>',
    visibleText:
      '<div style="background:url(https://example.com/track.png)"><span style="background-image:url(javascript:alert(1))">styled</span></div>',
  },
  {
    id: 'html-in-file-name',
    description: 'a file name made of markup, as a path in inline code and as a link',
    markdown: `Changed \`src/<img src=x onerror=${sentinel('html-in-file-name')}>.ts\` and [<b>file</b>](./<script>.md)`,
    visibleText: `src/<img src=x onerror=${sentinel('html-in-file-name')}>.ts`,
  },
  {
    id: 'bidi-controls',
    description: 'Unicode bidirectional overrides that reorder what is displayed',
    markdown: 'access = "user\u202e \u2066// admin\u2069 \u2066"; run\u202d(rm -rf ~)',
    visibleText: 'access = "user\u202e \u2066// admin\u2069 \u2066"; run\u202d(rm -rf ~)',
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
