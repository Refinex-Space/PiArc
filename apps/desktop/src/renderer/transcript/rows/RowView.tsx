// One transcript row by id: picks the component of its kind (one per P0 row type, architecture
// section 8.2) and keeps a row that fails to render from taking the transcript down with it
// (I50: an error boundary per row).
import { Component, memo, useLayoutEffect, useRef, type ErrorInfo, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { useTranscriptRow, useTranscriptServices } from '../services.js';
import { useListActions } from './list-actions.js';
import { AgentMessageRow, OptimisticRow, ThinkingRow, UserMessageRow } from './messages.js';
import { CompactionRow, ErrorCard, UncertainCard, WorkingRow } from './status.js';
import { BashCard, FileChangeCard, ToolGroupRow } from './tools.js';

function useCommitted(id: string): void {
  const { renderCounter } = useTranscriptServices();
  const { rowCommitted } = useListActions();
  const mounted = useRef(false);
  // Runs after every commit of the row: counts actual re-renders (not render attempts, and not
  // the first mount of a row scrolled into view), and lets the list keep the bottom in view
  // before the frame is painted.
  useLayoutEffect(() => {
    if (mounted.current) {
      renderCounter?.note(id);
    }
    mounted.current = true;
    rowCommitted();
  });
}

function RowFailed() {
  const t = useT();
  return (
    <div className="row row-failed muted" data-testid="row-failed" role="note">
      {t('transcript.rowFailed')}
    </div>
  );
}

/** Contains a render failure to its row. */
export class RowBoundary extends Component<
  { readonly id: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[transcript] row ${this.props.id} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? <RowFailed /> : this.props.children;
  }
}

const RowContent = memo(function RowContent({ id }: { readonly id: string }) {
  const row = useTranscriptRow(id);
  useCommitted(id);
  switch (row?.kind) {
    case undefined:
      return null;
    case 'optimistic':
      return <OptimisticRow row={row} />;
    case 'group':
      return <ToolGroupRow id={id} members={row.members} />;
    case 'error':
      return <ErrorCard row={row} />;
    case 'uncertain':
      return <UncertainCard row={row} />;
    case 'working':
      return <WorkingRow />;
    case 'item':
      break;
  }
  const { item } = row;
  switch (item.type) {
    case 'userMessage':
      return <UserMessageRow id={id} item={item} />;
    case 'agentMessage':
      return <AgentMessageRow id={id} item={item} />;
    case 'reasoning':
      return <ThinkingRow id={id} item={item} startedAt={row.startedAt} endedAt={row.endedAt} />;
    case 'commandExecution':
      return <BashCard id={id} item={item} startedAt={row.startedAt} />;
    case 'fileChange':
      return <FileChangeCard id={id} item={item} />;
    case 'contextCompaction':
      return <CompactionRow id={id} item={item} />;
    default:
      // Other tool calls are shown inside tool groups.
      return <ToolGroupRow id={id} members={[id]} />;
  }
});

/** One transcript row by id. */
export const RowView = memo(function RowView({ id }: { readonly id: string }) {
  return (
    <RowBoundary id={id}>
      <RowContent id={id} />
    </RowBoundary>
  );
});
