// Only the exact delimiters produced by the file editor are semantic. All other HTML
// continues through the regular text-only rendering path.
import type { MarkdownConfig } from '@lezer/markdown';
import type { TokenizerAndRendererExtension } from 'marked';

export const inlineStyles = ['mark', 'sub', 'sup', 'u'] as const;

const patterns = {
  mark: {
    open: '==',
    close: '==',
    node: 'Highlight',
    match: /^==(?!=)((?!\s)(?:\\[^\n]|[^\\\n])+?)==(?!=)/u,
  },
  sub: {
    open: '~',
    close: '~',
    node: 'Subscript',
    match: /^~(?!~)((?!\s)(?:\\[^\n]|[^~\\\n])+?)~(?!~)/u,
  },
  sup: {
    open: '^',
    close: '^',
    node: 'Superscript',
    match: /^\^(?!\^)((?!\s)(?:\\[^\n]|[^\\\n^])+?)\^(?!\^)/u,
  },
  u: { open: '<u>', close: '</u>', node: 'Underline', match: /^<u>([^\n]+?)<\/u>/u },
};
export const inlineStyleTokens: TokenizerAndRendererExtension[] = inlineStyles.map((kind) => {
  const { open, match } = patterns[kind];
  return {
    name: 'fileStyle-' + kind,
    level: 'inline',
    start(src) {
      const i = src.indexOf(open);
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = match.exec(src);
      if (!m?.[1] || /\s$/u.test(m[1])) return undefined;
      return { type: 'fileStyle-' + kind, raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
  };
});
export const styleSyntax: MarkdownConfig = {
  defineNodes: [...inlineStyles.map((k) => patterns[k].node), 'FileStyleMark'],
  parseInline: inlineStyles.map((k) => {
    const { open, close, node } = patterns[k],
      delimiter = { resolve: node, mark: 'FileStyleMark' };
    return {
      name: node,
      before: k === 'u' ? 'HTMLTag' : 'Emphasis',
      parse(cx, next, pos) {
        const asymmetric = open !== close;
        const opening = next === open.charCodeAt(0) && cx.slice(pos, pos + open.length) === open;
        const ending = asymmetric ? cx.slice(pos, pos + close.length) === close : opening;
        if (!opening && !ending) return -1;
        const width = opening ? open.length : close.length;
        if (!asymmetric && (cx.char(pos - 1) === next || cx.char(pos + width) === next)) return -1;
        const canOpen = opening && /\S/u.test(cx.slice(pos + width, pos + width + 1));
        const canClose = ending && /\S/u.test(cx.slice(pos - 1, pos));
        return canOpen || canClose
          ? cx.addDelimiter(delimiter, pos, pos + width, canOpen, canClose)
          : -1;
      },
    };
  }),
};
