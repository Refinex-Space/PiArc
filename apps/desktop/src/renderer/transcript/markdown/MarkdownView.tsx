// Renders the worker's blocks and spans with React elements only (architecture sections 8.4 and
// 10.3): no innerHTML, raw HTML shown as text, links opened through the main process's
// confirmation (`window.piarc.openExternal`), images never loaded and shown as links. Blocks are
// memoized by identity, so while a message streams only its changed tail re-renders.
import { memo, type MouseEvent, type ReactNode } from 'react';

import { CodeBlock } from '../highlight/CodeBlock.js';
import type { Align, Block, Span } from './ir.js';

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault();
  window.piarc.openExternal(href).catch((error: unknown) => {
    console.error('[transcript] opening a link failed', error);
  });
}

function Link({
  href,
  title,
  children,
}: {
  href: string | null;
  title: string | null;
  children: ReactNode;
}) {
  if (href === null) {
    return (
      <span className="md-link-blocked" title="This link target is not allowed">
        {children}
      </span>
    );
  }
  return (
    <a
      className="md-link"
      href={href}
      title={title ?? href}
      onClick={(event) => {
        openLink(event, href);
      }}
    >
      {children}
    </a>
  );
}

function Spans({ spans }: { spans: readonly Span[] }): ReactNode {
  return spans.map((span, index) => <SpanView key={index} span={span} />);
}

function SpanView({ span }: { span: Span }): ReactNode {
  switch (span.kind) {
    case 'text':
      return span.text;
    case 'strong':
      return (
        <strong>
          <Spans spans={span.children} />
        </strong>
      );
    case 'emphasis':
      return (
        <em>
          <Spans spans={span.children} />
        </em>
      );
    case 'delete':
      return (
        <del>
          <Spans spans={span.children} />
        </del>
      );
    case 'code':
      return <code className="md-inline-code">{span.text}</code>;
    case 'break':
      return <br />;
    case 'link':
      return (
        <Link href={span.href} title={span.title}>
          <Spans spans={span.children} />
        </Link>
      );
    case 'image':
      return (
        <Link href={span.href} title={span.title}>
          <span className="md-image-label">
            Image: {span.alt === '' ? (span.href ?? '') : span.alt}
          </span>
        </Link>
      );
    case 'html':
      return <span className="md-raw-html">{span.text}</span>;
  }
}

/** `tight`: the items of a tight list, whose paragraphs render without paragraph spacing. */
function Blocks({
  blocks,
  tight = false,
}: {
  blocks: readonly Block[];
  tight?: boolean;
}): ReactNode {
  return blocks.map((block, index) =>
    tight && block.kind === 'paragraph' ? (
      <Spans key={index} spans={block.spans} />
    ) : (
      <BlockView key={index} block={block} />
    ),
  );
}

const BlockView = memo(function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p>
          <Spans spans={block.spans} />
        </p>
      );
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level));
      const content = <Spans spans={block.spans} />;
      switch (level) {
        case 1:
          return <h1>{content}</h1>;
        case 2:
          return <h2>{content}</h2>;
        case 3:
          return <h3>{content}</h3>;
        case 4:
          return <h4>{content}</h4>;
        case 5:
          return <h5>{content}</h5>;
        default:
          return <h6>{content}</h6>;
      }
    }
    case 'code':
      return <CodeBlock lang={block.lang} code={block.text} complete={block.complete} />;
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.checked === null ? undefined : 'md-task'}>
          {item.checked === null ? null : (
            <input type="checkbox" checked={item.checked} disabled aria-label="Task" />
          )}
          <Blocks blocks={item.blocks} tight={!block.loose} />
        </li>
      ));
      const className = block.loose ? 'md-list md-loose' : 'md-list';
      return block.ordered ? (
        <ol className={className} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      );
    }
    case 'blockquote':
      return (
        <blockquote>
          <Blocks blocks={block.blocks} />
        </blockquote>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className={alignClass(block.align[index])}>
                    <Spans spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} className={alignClass(block.align[index])}>
                      <Spans spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr />;
    case 'html':
      return <pre className="md-raw-html-block">{block.text}</pre>;
  }
});

function alignClass(align: Align | undefined): string | undefined {
  return align === null || align === undefined ? undefined : `md-align-${align}`;
}

/** A message's blocks. */
export const MarkdownView = memo(function MarkdownView({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  );
});
