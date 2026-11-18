// A session in the main area: its title and status, and its messages as plain text. The full
// transcript (Markdown, tool cards, virtualization, composer) is T19's; this view reads the
// same store rows, so T19 replaces the row rendering without touching the data flow.
import { memo, useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { useWindowFocused } from '../app/window-focus.js';
import { useRow, useRowIds, useSession, useStore, useTurnState } from '../store/hooks.js';
import { badgeOf } from '../store/status.js';
import { sessionTitle } from './SessionRow.js';
import { StatusBadge } from './StatusBadge.js';
import { useUi } from './ui.js';

/** How many persisted items a session shows when it is opened. */
const WINDOW = 200;

const Row = memo(function Row({
  sessionId,
  id,
}: {
  readonly sessionId: string;
  readonly id: string;
}) {
  const t = useT();
  const row = useRow(sessionId, id);
  if (row === undefined) {
    return null;
  }
  if (row.kind === 'optimistic') {
    return (
      <div className="message message-user is-pending" data-testid="optimistic-message">
        <div className="message-author">{t('conversation.you')}</div>
        <div className="message-text">{row.text}</div>
        {row.turnId === undefined && <div className="muted small">{t('conversation.pending')}</div>}
      </div>
    );
  }
  const { item } = row;
  switch (item.type) {
    case 'userMessage':
      return (
        <div className="message message-user" data-testid="user-message">
          <div className="message-author">{t('conversation.you')}</div>
          <div className="message-text">{item.text}</div>
        </div>
      );
    case 'agentMessage':
      return (
        <div className="message message-agent" data-testid="agent-message">
          <div className="message-author">{t('conversation.agent')}</div>
          <div className="message-text">{item.text}</div>
        </div>
      );
    case 'reasoning':
      return <div className="message-note muted small">{t('conversation.thinking')}</div>;
    default:
      return (
        <div className="message-note muted small" data-testid="tool-item">
          <code>{'tool' in item && typeof item.tool === 'string' ? item.tool : item.type}</code>
          {' · '}
          {item.status}
        </div>
      );
  }
});

export function Conversation({ id }: { readonly id: string }) {
  const t = useT();
  const ui = useUi();
  const store = useStore();
  const session = useSession(id);
  const ids = useRowIds(id);
  const { error } = useTurnState(id);
  const [loading, setLoading] = useState(false);

  // Live notifications while the session is shown; the persisted conversation when it was not
  // started in this window.
  useEffect(() => ui.connection.watchSession(id), [ui.connection, id]);
  useEffect(() => {
    const transcript = store.transcript(id);
    if (transcript.rowIds().length > 0) {
      return;
    }
    let active = true;
    setLoading(true);
    window.piarc.transcriptWindow(id, WINDOW).then(
      (text) => {
        if (!active) {
          return;
        }
        setLoading(false);
        const parsed: unknown = JSON.parse(text);
        const items =
          typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { items?: unknown }).items)
            ? (parsed as { items: unknown[] }).items.flatMap((entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as { entryId?: unknown }).entryId === 'string'
                  ? [entry as { entryId: string; item: unknown }]
                  : [],
              )
            : [];
        if (transcript.rowIds().length === 0) {
          transcript.load(items);
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoading(false);
          console.error('[conversation] cannot load the transcript', failure);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [store, id]);

  // Shown to the user (the window in front): no longer unread.
  const unread = session?.unread === true;
  const focused = useWindowFocused();
  useEffect(() => {
    if (unread && focused) {
      window.piarc.markSessionRead(id).catch((failure: unknown) => {
        console.error('[conversation] cannot mark the session read', failure);
      });
    }
  }, [id, unread, focused]);

  const title = sessionTitle(session?.title, t('session.untitled'));
  return (
    <section className="conversation" data-testid="conversation" data-session-id={id}>
      <header className="titlebar main-titlebar conversation-header">
        {session !== undefined && <StatusBadge state={badgeOf(session)} />}
        <h1 className="conversation-title truncate" data-testid="conversation-title">
          {title}
        </h1>
      </header>
      <div className="conversation-body">
        {loading && ids.length === 0 && <p className="muted">{t('conversation.loading')}</p>}
        {!loading && ids.length === 0 && <p className="muted">{t('conversation.empty')}</p>}
        {ids.map((rowId) => (
          <Row key={rowId} sessionId={id} id={rowId} />
        ))}
        {(error ?? session?.error) !== undefined && session?.status === 'error' && (
          <p className="error-text" role="alert">
            {t('conversation.error', { message: error ?? session.error ?? '' })}
          </p>
        )}
      </div>
    </section>
  );
}
