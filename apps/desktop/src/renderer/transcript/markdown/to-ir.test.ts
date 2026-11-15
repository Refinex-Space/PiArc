import { describe, expect, it } from 'vitest';

import { XSS_PAYLOADS } from '../../lab/fixtures/xss-payloads.js';
import { parseMarkdown } from './incremental.js';
import type { Block, Span } from './ir.js';
import { decodeCharacterReferences, safeHref } from './text.js';

function allSpans(blocks: readonly Block[]): Span[] {
  const result: Span[] = [];
  const visitSpans = (spans: readonly Span[]): void => {
    for (const span of spans) {
      result.push(span);
      if ('children' in span) {
        visitSpans(span.children);
      }
    }
  };
  const visit = (list: readonly Block[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          visitSpans(block.spans);
          break;
        case 'blockquote':
          visit(block.blocks);
          break;
        case 'list':
          block.items.forEach((item) => {
            visit(item.blocks);
          });
          break;
        case 'table':
          [block.header, ...block.rows].forEach((row) => {
            row.forEach(visitSpans);
          });
          break;
        default:
          break;
      }
    }
  };
  visit(blocks);
  return result;
}

describe('decodeCharacterReferences', () => {
  it('decodes named and numeric references and keeps unknown ones', () => {
    expect(decodeCharacterReferences('&amp; &lt;b&gt; &copy; &#x1F680; &#65; &nosuch; &amp')).toBe(
      '& <b> © 🚀 A &nosuch; &amp',
    );
    expect(decodeCharacterReferences('&#0; &#xD800; &#1114112;')).toBe('� � �');
  });
});

describe('safeHref', () => {
  it('keeps https, http and mailto URLs', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('drops every other target, including encoded ones', () => {
    for (const target of [
      'javascript:alert(1)',
      ' JAVASCRIPT:alert(1)',
      '&#106;avascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'vbscript:msgbox',
      '/relative/path',
      'app://piarc/index.html',
      '',
    ]) {
      expect(safeHref(target)).toBeNull();
    }
  });
});

describe('model output to blocks', () => {
  it('turns every XSS payload into text or a link without a dangerous target', () => {
    for (const payload of XSS_PAYLOADS) {
      const blocks = parseMarkdown(payload.markdown);
      for (const span of allSpans(blocks)) {
        if (span.kind === 'link' || span.kind === 'image') {
          expect(span.href === null || /^(https?|mailto):/u.test(span.href)).toBe(true);
        }
      }
      expect(JSON.stringify(blocks)).not.toContain('"href":"javascript');
    }
  });

  it('keeps raw HTML as html nodes, verbatim', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      { kind: 'html', text: '<script>alert(1)</script>' },
    ]);
    expect(parseMarkdown('a <b onclick="x">b</b>')).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'a ' },
          { kind: 'html', text: '<b onclick="x">' },
          { kind: 'text', text: 'b' },
          { kind: 'html', text: '</b>' },
        ],
      },
    ]);
  });

  it('converts GFM tables, task lists and images', () => {
    expect(
      parseMarkdown(
        '| a | b |\n|:-|-:|\n| 1 | **2** |\n\n- [x] done\n- [ ] open\n\n![alt](https://x.test/i.png)',
      ),
    ).toEqual([
      {
        kind: 'table',
        align: ['left', 'right'],
        header: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]],
        rows: [
          [
            [{ kind: 'text', text: '1' }],
            [{ kind: 'strong', children: [{ kind: 'text', text: '2' }] }],
          ],
        ],
      },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        loose: false,
        items: [
          {
            checked: true,
            blocks: [{ kind: 'paragraph', spans: [{ kind: 'text', text: 'done' }] }],
          },
          {
            checked: false,
            blocks: [{ kind: 'paragraph', spans: [{ kind: 'text', text: 'open' }] }],
          },
        ],
      },
      {
        kind: 'paragraph',
        spans: [{ kind: 'image', href: 'https://x.test/i.png', alt: 'alt', title: null }],
      },
    ]);
  });

  it('decodes references in text but not in code', () => {
    expect(parseMarkdown('&lt;b&gt; `&lt;b&gt;`')).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: '<b> ' },
          { kind: 'code', text: '&lt;b&gt;' },
        ],
      },
    ]);
  });

  it('takes the first word of the info string as the language', () => {
    expect(parseMarkdown('```ts title="a.ts"\nx\n```')).toEqual([
      { kind: 'code', lang: 'ts', text: 'x', complete: true },
    ]);
  });
});
