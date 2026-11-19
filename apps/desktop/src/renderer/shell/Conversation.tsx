// A session in the main area (architecture section 8.2): its title and status, the transcript
// (Core's live notifications and its persisted history through one reducer, T19) and the
// composer with the queue above it. A session shown before in this window is still in the store
// and shows at once; one shown for the first time loads its last page of history, and earlier
// pages when the user scrolls to the top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { useWindowFocused } from '../app/window-focus.js';
import type { PaletteCommand } from '../composer/command-plugin.js';
import {
  Composer,
  type ComposerHandlers,
  type ComposerSubmission,
  type MentionSource,
} from '../composer/Composer.js';
import type { MentionData } from '../composer/schema.js';
import { useNeedsReload, useQueue, useSession, useStore, useTurnInfo } from '../store/hooks.js';
import { badgeOf } from '../store/status.js';
import type { SessionTranscript, TranscriptEntry } from '../store/transcript.js';
import { HISTORY } from '../transcript/constants.js';
import { TranscriptContext, type TranscriptView } from '../transcript/services.js';
import { Transcript } from '../transcript/Transcript.js';
import { reason } from './errors.js';
import { keyOf, useModelCatalog } from './model-catalog.js';
import { ModelMenus } from './ModelMenus.js';
import { PermissionModeMenu } from './PermissionModeMenu.js';
import { QueueList } from './QueueList.js';
import { SessionInput, type Draft } from './session-input.js';
import { sessionTitle } from './SessionRow.js';
import { StatusBadge } from './StatusBadge.js';
import { useUi } from './ui.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's `transcript_window` answer: `{ start, items: [{ entryId, item }] }`. */
function parseWindow(text: string): {
  start: number;
  items: TranscriptEntry[];
  harness?: unknown;
} {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { start: 0, items: [] };
  }
  const items = value.items.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.entryId === 'string'
      ? [
          {
            entryId: entry.entryId,
            ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
            item: entry.item,
          },
        ]
      : [],
  );
  return {
    start: typeof value.start === 'number' ? value.start : 0,
    items,
    harness: value.harness,
  };
}

/** Core's file search as the composer's `@` source, below the session's working directory. */
function coreMentions(root: string | undefined, limit: number): MentionSource {
  const searchId = `mention-${crypto.randomUUID()}`;
  return {
    search: async (query) => {
      if (root === undefined) {
        return [];
      }
      const value: unknown = JSON.parse(
        await window.piarc.searchFiles(searchId, root, query, limit),
      );
      const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
      return results.flatMap((result: unknown): MentionData[] =>
        isRecord(result) && typeof result.path === 'string' && typeof result.name === 'string'
          ? [{ id: result.path, label: result.name, path: result.path }]
          : [],
      );
    },
    cancel: () => {
      window.piarc.cancelFileSearch(searchId).catch((error: unknown) => {
        console.error('[conversation] cannot cancel the file search', error);
      });
    },
  };
}

function draftOf(submission: ComposerSubmission): Draft {
  return {
    text: submission.text,
    mentions: submission.spans,
    pending: submission.attachments,
    stored: [],
  };
}

/** Loads the history when the session was not shown before, and again after lost events. */
function useHistory(
  id: string,
  transcript: SessionTranscript,
): {
  loading: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
} {
  const needsReload = useNeedsReload(id);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierRequest = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    if (transcript.hasContent() && !needsReload) {
      return;
    }
    let active = true;
    setLoading(true);
    window.piarc.transcriptWindow(id, null, HISTORY.pageItems).then(
      (text) => {
        if (!active) {
          return;
        }
        setLoading(false);
        const window = parseWindow(text);
        if (!transcript.hasContent() || transcript.needsReload()) {
          transcript.load(window.items, window.start);
          transcript.harness.load(window.harness);
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
  }, [id, transcript, needsReload]);
  const loadEarlier = useCallback(() => {
    if (earlierRequest.current !== undefined) return earlierRequest.current;
    const start = transcript.historyStart();
    if (start === undefined || start === 0) return Promise.resolve();
    const from = Math.max(0, start - HISTORY.pageItems);
    setLoadingEarlier(true);
    earlierRequest.current = window.piarc
      .transcriptWindow(id, from, start - from)
      .then((text) => {
        const page = parseWindow(text);
        if (transcript.historyStart() === start) transcript.prepend(page.items, page.start);
      })
      .catch((failure: unknown) => {
        console.error('[conversation] cannot load earlier messages', failure);
      })
      .finally(() => {
        earlierRequest.current = undefined;
        setLoadingEarlier(false);
      });
    return earlierRequest.current;
  }, [id, transcript]);
  return { loading, loadingEarlier, loadEarlier };
}

export function Conversation({
  id,
  modeButton,
  modelButton,
  effortButton,
}: {
  readonly id: string;
  readonly modelButton: React.Ref<HTMLButtonElement>;
  readonly effortButton: React.Ref<HTMLButtonElement>;
  readonly modeButton: React.Ref<HTMLButtonElement>;
}) {
  const t = useT();
  const ui = useUi();
  const store = useStore();
  const session = useSession(id);
  const {
    catalog,
    refresh,
    failure: catalogFailure,
  } = useModelCatalog(session?.open ? id : undefined, true);
  const model = catalog?.models.find((m) => catalog.model && keyOf(m) === keyOf(catalog.model));
  const transcript = store.transcript(id);
  const turn = useTurnInfo(id);
  const queue = useQueue(id);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useMemo(() => new SessionInput(window.piarc, store, id), [store, id]);

  // Indexed sessions carry no live policy. Resume alongside the history read so the
  // environment bar reflects the latest persisted mode as soon as Core restores it.
  const needsResume = session?.open === false;
  useEffect(() => {
    if (!needsResume) return;
    let current = true;
    input.ensureOpen().catch((failure: unknown) => {
      if (current) setError(reason(failure));
    });
    return () => {
      current = false;
    };
  }, [input, needsResume]);

  // Live notifications: the window keeps receiving them once the session was shown, so a
  // cached transcript stays current when the user comes back.
  useEffect(() => {
    ui.watchSession(id);
  }, [ui, id]);
  const history = useHistory(id, transcript);

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

  const view = useMemo<TranscriptView>(
    () => ({
      services: ui.transcriptServices,
      transcript,
      actions: {
        retry: (turnId) => {
          void input.retry(turnId);
        },
        resend: (clientId) => {
          void input.resend(clientId);
        },
      },
    }),
    [ui.transcriptServices, transcript, input],
  );
  const mentions = useMemo(
    () => coreMentions(session?.cwd ?? session?.workspace, ui.composer?.maxSearchResults ?? 20),
    [session?.cwd, session?.workspace, ui.composer?.maxSearchResults],
  );
  const runCommand = useCallback(
    (command: PaletteCommand) => {
      switch (command.action) {
        case 'newSession':
          ui.show({ kind: 'home', workspace: session?.workspace });
          break;
        case 'compact':
          window.piarc.compact(id).catch((failure: unknown) => {
            setError(t('composer.failed', { reason: reason(failure) }));
          });
          break;
        case 'help':
          ui.openShortcuts();
          break;
        default:
          break;
      }
    },
    [ui, session?.workspace, id, t],
  );
  const handlers = useMemo<ComposerHandlers>(
    () => ({
      submit(intent, submission) {
        setError(undefined);
        const draft = draftOf(submission);
        if (intent === 'send') {
          void input.send(draft);
          return;
        }
        input.add(intent === 'steer' ? 'steer' : 'followUp', draft).catch((failure: unknown) => {
          setError(t('composer.failed', { reason: reason(failure) }));
        });
      },
      stop() {
        window.piarc.abort(id).catch((failure: unknown) => {
          console.error('[conversation] cannot stop the turn', failure);
        });
      },
      command: () => undefined,
      runCommand,
      mentionOpened: () => undefined,
      mentionChosen: () => undefined,
    }),
    [input, id, t, runCommand],
  );

  const title = sessionTitle(session?.title, t('session.untitled'));
  const empty = !history.loading && !transcript.hasContent();
  return (
    <section className="conversation" data-testid="conversation" data-session-id={id}>
      <header className="titlebar main-titlebar conversation-header">
        {session !== undefined && <StatusBadge state={badgeOf(session)} />}
        <h1 className="conversation-title truncate" data-testid="conversation-title">
          {title}
        </h1>
      </header>
      <TranscriptContext.Provider value={view}>
        <div className="conversation-body">
          {history.loading && !transcript.hasContent() ? (
            <p className="muted conversation-note">{t('conversation.loading')}</p>
          ) : null}
          {empty ? <p className="muted conversation-note">{t('conversation.empty')}</p> : null}
          <Transcript onReachTop={history.loadEarlier} loadingEarlier={history.loadingEarlier} />
        </div>
      </TranscriptContext.Provider>
      <div className="conversation-composer">
        <Composer
          running={turn.running}
          handlers={handlers}
          mentions={mentions}
          commands={ui.composer?.commands ?? []}
          limits={ui.composer?.limits}
          supportsImages={model?.vision}
          error={
            error ?? (catalogFailure ? t('models.failed', { reason: catalogFailure }) : undefined)
          }
          above={
            queue.length === 0 ? null : (
              <QueueList
                items={queue}
                onEdit={(itemId, text) => {
                  window.piarc.editQueueItem(id, itemId, text).catch((failure: unknown) => {
                    setError(t('composer.failed', { reason: reason(failure) }));
                  });
                }}
                onDelete={(itemId) => {
                  window.piarc.deleteQueueItem(id, itemId).catch((failure: unknown) => {
                    setError(t('composer.failed', { reason: reason(failure) }));
                  });
                }}
              />
            )
          }
        />
        <div className="environment-bar">
          <ModelMenus
            id={id}
            catalog={catalog}
            running={turn.running}
            modelButton={modelButton}
            effortButton={effortButton}
            onChange={refresh}
            onError={(e) => {
              setError(t('models.failed', { reason: reason(e) }));
            }}
          />
          <PermissionModeMenu
            key={id}
            id={id}
            mode={session?.open === true ? session.permissionMode : undefined}
            buttonRef={modeButton}
            onError={(failure) => {
              setError(t('composer.failed', { reason: reason(failure) }));
            }}
          />
        </div>
      </div>
    </section>
  );
}
