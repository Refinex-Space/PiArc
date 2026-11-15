// "Copy this message" (architecture section 8.4): the Markdown source as received, or plain text
// derived from the parsed blocks without any Markdown syntax.
import type { Block, Span } from './markdown/ir.js';

function spanText(spans: readonly Span[]): string {
  return spans
    .map((span) => {
      switch (span.kind) {
        case 'text':
        case 'code':
        case 'html':
          return span.text;
        case 'break':
          return '\n';
        case 'strong':
        case 'emphasis':
        case 'delete':
          return spanText(span.children);
        case 'link': {
          const label = spanText(span.children);
          return span.href === null || span.href === label ? label : `${label} (${span.href})`;
        }
        case 'image':
          return span.href === null ? span.alt : `${span.alt} (${span.href})`;
      }
    })
    .join('');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : `${prefix}${line}`))
    .join('\n');
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return spanText(block.spans);
    case 'code':
      return block.text;
    case 'html':
      return block.text;
    case 'rule':
      return '';
    case 'blockquote':
      return blocksText(block.blocks);
    case 'list':
      return block.items
        .map((item, index) => {
          const marker =
            item.checked === null
              ? block.ordered
                ? `${String(block.start + index)}. `
                : '• '
              : item.checked
                ? '[x] '
                : '[ ] ';
          const body = item.blocks.map(blockText).join(block.loose ? '\n\n' : '\n');
          return marker + indent(body, ' '.repeat(marker.length));
        })
        .join(block.loose ? '\n\n' : '\n');
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => spanText(cell)).join('\t'))
        .join('\n');
  }
}

/** Plain text of parsed blocks: blocks separated by a blank line, table cells by tabs. */
export function blocksText(blocks: readonly Block[]): string {
  return blocks
    .map(blockText)
    .filter((text) => text !== '')
    .join('\n\n');
}
