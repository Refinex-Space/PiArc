// Character references and link targets in model output.
import { characterEntities } from 'character-entities';

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function fromCodePoint(codePoint: number): string {
  // CommonMark: invalid code points and NUL become U+FFFD.
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes HTML5 named and numeric character references the way CommonMark does (named ones
 * need their semicolon). Unknown names stay as written. Used for text, link targets and
 * titles; code spans and code blocks keep references literally.
 */
export function decodeCharacterReferences(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(
    REFERENCE,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) {
        return fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return fromCodePoint(Number.parseInt(hex, 16));
      }
      if (name !== undefined && Object.hasOwn(characterEntities, name)) {
        return characterEntities[name] ?? match;
      }
      return match;
    },
  );
}

/** URL schemes a link in model output may open (the main process checks the same list). */
export const LINK_PROTOCOLS: readonly string[] = ['https:', 'http:', 'mailto:'];

/**
 * The link target to keep, or `null`: only absolute `https:`, `http:` and `mailto:` URLs pass,
 * after character references are decoded (so `&#106;avascript:` is caught). Project files
 * are resolved separately and are never returned as navigable URLs.
 */
export function safeHref(raw: string): string | null {
  const decoded = decodeCharacterReferences(raw).trim();
  if (decoded === '' || !URL.canParse(decoded)) {
    return null;
  }
  const url = new URL(decoded);
  return LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
}

/** Local targets never become DOM hrefs or OS URLs. The renderer resolves them against
 * the actual session root and Core checks the resulting file operation. */
export function markdownTarget(raw: string): { href: string | null; projectTarget?: string } {
  const href = safeHref(raw);
  if (href) return { href };
  const decoded = decodeCharacterReferences(raw).trim();
  const hash = decoded.indexOf('#');
  if (
    !decoded ||
    decoded.includes('?') ||
    (hash !== -1 && !/^#L\d+(?:-L?\d+)?$/u.test(decoded.slice(hash)))
  )
    return { href: null };
  let path: string;
  try {
    path = decodeURIComponent(decoded);
  } catch {
    return { href: null };
  }
  if (
    path.startsWith('//') ||
    Array.from(path).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ||
    (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path))
  )
    return { href: null };
  return { href: null, projectTarget: path };
}
