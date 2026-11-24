import { decodeCharacterReferences, safeHref } from '../transcript/markdown/text.js';
import { isProjectPath } from '../../shared/project-files.js';

function relativeFileLink(path: string, value: string) {
  if (
    !value ||
    /^[#/\\?]|^[a-z][a-z\d+.-]*:/iu.test(value) ||
    value.includes('\\') ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32)
  )
    return undefined;
  const candidate = path.split('/').slice(0, -1);
  const end = value.search(/[?#]/u);
  const name = end === -1 ? value : value.slice(0, end);
  for (const part of name.split('/')) {
    if (part === '..') {
      if (!candidate.length) return undefined;
      candidate.pop();
    } else if (part !== '.' && part) candidate.push(part);
  }
  const resolved = candidate.join('/');
  return isProjectPath(resolved) ? resolved : undefined;
}

const presentationTags = new Set(
  'h1 h2 h3 h4 h5 h6 p div section article header main footer aside blockquote ol ul li b strong i em u s span small sub sup mark pre code table thead tbody tr th td br hr details summary figure figcaption dl dt dd a'.split(
    ' ',
  ),
);
const omittedContent = new Set([
  'head',
  'script',
  'style',
  'iframe',
  'object',
  'noscript',
  'template',
  'svg',
  'math',
  'textarea',
  'select',
  'audio',
  'video',
]);
const voidTags = new Set(
  'br hr img input link meta base area source track embed col wbr'.split(' '),
);
export type HtmlPart =
  string | { tag: string; href?: string; local?: string; children: HtmlPart[] };

// A bounded tokenizer for the static document view. It builds only the small presentation model
// above. In particular, it never passes an untrusted tag or property to React.
export function htmlPresentation(html: string, path: string): HtmlPart[] {
  const root: HtmlPart[] = [];
  const stack: { tag: string; children: HtmlPart[] }[] = [{ tag: '', children: root }];
  const tokens = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z!](?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+|</gu;
  const activeTags = new Set(['script', 'style', 'textarea', 'iframe', 'noscript']);
  let omitted: string | undefined;
  let count = 0;
  for (const match of html.matchAll(tokens)) {
    if (++count > 50000) return root;
    const token = match[0];
    if (token.startsWith('<!')) continue;
    const name = /^<(\/?)([a-z][\w:-]*)/iu.exec(token);
    const tag = name?.[2]?.toLowerCase(),
      closing = name?.[1] === '/';
    if (omitted) {
      if (closing && tag === omitted) omitted = undefined;
      continue;
    }
    if (!tag) {
      (stack.at(-1)?.children ?? root).push(decodeCharacterReferences(token));
      continue;
    }
    if (closing) {
      const index = stack.findLastIndex((item) => item.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (omittedContent.has(tag)) {
      if (activeTags.has(tag) || !token.endsWith('/>')) omitted = tag;
      continue;
    }
    if (!presentationTags.has(tag)) continue;
    const node: Exclude<HtmlPart, string> = { tag, children: [] };
    if (tag === 'a') {
      const attrs = token
        .slice(name?.[0].length)
        .matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu);
      for (const attr of attrs) {
        if (attr[1]?.toLowerCase() !== 'href') continue;
        const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
        const href = safeHref(value);
        if (href) node.href = href;
        else {
          const local = relativeFileLink(path, decodeCharacterReferences(value));
          if (local) node.local = local;
        }
        break;
      }
    }
    (stack.at(-1)?.children ?? root).push(node);
    if (!voidTags.has(tag) && !token.endsWith('/>') && stack.length < 64) stack.push(node);
  }
  return root;
}
