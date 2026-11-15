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
 * after character references are decoded (so `&#106;avascript:` is caught). Relative targets
 * have nothing to resolve against in the transcript and are dropped as well.
 */
export function safeHref(raw: string): string | null {
  const decoded = decodeCharacterReferences(raw).trim();
  if (decoded === '' || !URL.canParse(decoded)) {
    return null;
  }
  const url = new URL(decoded);
  return LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
}
