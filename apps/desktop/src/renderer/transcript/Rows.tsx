// Transcript rows (architecture section 8.2). Each row subscribes to its own entry in the store
// and to its own parsed document, so a streaming delta re-renders the streaming row only.
// T19 adds the remaining P0 row types (thinking, tool groups, bash and diff cards).
import { memo, useEffect, useLayoutEffect, useState } from 'react';

import { blocksText } from './copy.js';
import {
  useRow,
  type AgentMessageItem,
  type ToolCallItem,
  type UserSegment,
} from './item-store.js';
import { MarkdownView } from './markdown/MarkdownView.js';
import { useParsedDoc, useTranscriptServices } from './services.js';

/** How long a copy button shows its confirmation (ms). */
const COPIED_FEEDBACK_MS = 1_500;

function useCommitCount(id: string): void {
  const { renderCounter } = useTranscriptServices();
  // Runs after every commit of the row: counts actual re-renders, not render attempts.
  useLayoutEffect(() => {
    renderCounter?.note(id);
  });
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <button
      type="button"
      className="row-action"
      onClick={() => {
        navigator.clipboard.writeText(text()).then(
          () => {
            setCopied(true);
          },
          (error: unknown) => {
            console.error('[transcript] copying failed', error);
          },
        );
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function AgentMessageRow({ id, item }: { id: string; item: AgentMessageItem }) {
  const { markdown, driver } = useTranscriptServices();
  const parsed = useParsedDoc(id);
  const complete = item.status !== 'inProgress';
  const streamed = driver.streams(id);
  useEffect(() => {
    if (complete && !streamed) {
      markdown.parseFinished(id, item.text);
    }
  }, [markdown, id, item.text, complete, streamed]);
  let body;
  if (parsed !== undefined) {
    body = <MarkdownView blocks={parsed.blocks} />;
  } else if (!streamed) {
    // Until the worker answers, a finished message shows as plain text of about the right size.
    body = <p className="md-fallback">{item.text}</p>;
  } else {
    body = null;
  }
  return (
    <article
      className="row row-agent"
      data-testid="agent-message"
      data-row-id={id}
      data-parsed={parsed === undefined ? 'none' : parsed.final ? 'final' : 'partial'}
      aria-label="Assistant message"
      aria-busy={!complete}
    >
      {body}
      {complete && parsed?.final === true ? (
        <div className="row-actions" data-testid="message-actions">
          <CopyButton label="Copy Markdown" text={() => item.text} />
          <CopyButton label="Copy text" text={() => blocksText(parsed.blocks)} />
        </div>
      ) : null}
    </article>
  );
}

function ToolCallRow({ id, item }: { id: string; item: ToolCallItem }) {
  const target = typeof item.arguments.path === 'string' ? item.arguments.path : '';
  return (
    <div className="row row-tool" data-testid="tool-call" data-row-id={id}>
      <span className="row-tool-name">{item.tool}</span>
      {target === '' ? null : <span className="row-tool-target">{target}</span>}
      <span className="row-tool-status">{item.status}</span>
    </div>
  );
}

function UserRow({ id, segments }: { id: string; segments: readonly UserSegment[] }) {
  return (
    <div className="row row-user" data-testid="user-message" data-row-id={id}>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          segment.text
        ) : (
          <span key={index} className="mention-chip" title={segment.path}>
            @{segment.label}
          </span>
        ),
      )}
    </div>
  );
}

/** One transcript row by id. */
export const RowView = memo(function RowView({ id }: { id: string }) {
  const { store } = useTranscriptServices();
  const row = useRow(store, id);
  useCommitCount(id);
  switch (row?.kind) {
    case 'agentMessage':
      return <AgentMessageRow id={id} item={row.item} />;
    case 'toolCall':
      return <ToolCallRow id={id} item={row.item} />;
    case 'user':
      return <UserRow id={id} segments={row.segments} />;
    case undefined:
      return null;
  }
});
