// A session in the main area (architecture section 8.2): its title and status, the transcript
// (Core's live notifications and its persisted history through one reducer, T19) and the
// composer with the queue above it. A session shown before in this window is still in the store
// and shows at once; one shown for the first time loads its last page of history, and earlier
// pages when the user scrolls to the top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { useWindowFocused } from '../app/window-focus.js';
import type { PaletteCommand } from '../composer/command-plugin.js';
import { builtin, typedBuiltin, type BuiltinAction } from '../composer/builtins.js';
import { EMPTY_COMMANDS, parseCommandsList, type CommandsList } from '../composer/commands-list.js';
import { Composer, type ComposerHandlers } from '../composer/Composer.js';
import type { SnippetData } from '../composer/schema.js';
import { onSnippet, takeSnippets } from '../composer/snippets.js';
import { coreMentions, draftOf } from '../composer/session-draft.js';
import {
  useBranches,
  useNeedsReload,
  useQueue,
  useSession,
  useStore,
  useTurnInfo,
} from '../store/hooks.js';
import type { SessionTranscript } from '../store/transcript.js';
import { LiveRegion } from '../transcript/LiveRegion.js';
import { HISTORY } from '../transcript/constants.js';
import { BranchTail } from '../changes/BranchSwitcher.js';
import { takeDraft } from '../changes/drafts.js';
import { RewindDialog, type RewindTarget } from '../changes/RewindDialog.js';
import { useBranchActions } from '../changes/use-branch-actions.js';
import { TranscriptContext, type TranscriptView } from '../transcript/services.js';
import { Transcript } from '../transcript/Transcript.js';
import { onLocate, rowShowsEntry, takeLocate } from '../store/locate.js';
import { DetailContext, useSessionDetail } from '../transcript/detail.js';
import { reason } from './errors.js';
import { keyOf, useModelCatalog } from './model-catalog.js';
import { ModelMenus } from './ModelMenus.js';
import { PermissionModeMenu } from './PermissionModeMenu.js';
import { AutoReviewStatus } from './AutoReviewStatus.js';
import { SandboxStatus } from './SandboxStatus.js';
import { UsageRing } from './ContextUsage.js';
import { NoticeBar } from './NoticeBar.js';
import { QueueList } from './QueueList.js';
import { compactFocus, SessionInput } from './session-input.js';
import { useUi } from './ui.js';
import { OutputStyleDialog } from './OutputStyleDialog.js';
import { showPanel } from './registry.js';
import { projectPath } from '../files/file-path.js';
import { openProjectFile, projectFileRoot } from '../files/navigation.js';
import { onCommandRequest, takeCommand } from './command-requests.js';
import { parseWindow } from '../store/history-window.js';
import { rememberMemoryTarget } from '../settings/memory-target.js';

/** Earlier pages a search result may load to find its entry. */
const LOCATE_PAGES = 50;

/**
 * A search result's entry (T35): once the history is loaded, the row that shows it, loading
 * earlier pages while it is not there yet. A message on another branch is not shown: the user
 * is told.
 */
function useLocated(
  id: string,
  transcript: SessionTranscript,
  history: { loading: boolean; loadEarlier: () => Promise<void> },
  notFound: (text: string) => void,
): { rowId: string; nonce: number } | undefined {
  const t = useT();
  const [focus, setFocus] = useState<{ rowId: string; nonce: number }>();
  const [request, setRequest] = useState(() => takeLocate(id));
  useEffect(
    () =>
      onLocate(() => {
        const next = takeLocate(id);
        if (next !== undefined) setRequest(next);
      }),
    [id],
  );
  const { loading, loadEarlier } = history;
  useEffect(() => {
    if (request === undefined || loading || !transcript.hasContent()) return;
    // Cleared when the effect is replaced: a stale search stops.
    const run = { active: true };
    const find = () => transcript.rowIds().find((row) => rowShowsEntry(row, request.entryId));
    void (async () => {
      // Rows shown live carry the projector's ids, rows from the history carry Pi's entry ids:
      // an idle session is read again from its history when the entry is not found.
      if (find() === undefined && !transcript.isRunning()) {
        const window = parseWindow(
          await globalThis.window.piarc.transcriptWindow(id, null, HISTORY.pageItems),
        );
        if (!run.active) return;
        transcript.load(window.items, window.start);
        transcript.harness.load(window.harness);
        transcript.branches.load(window.branches);
      }
      for (let page = 0; page <= LOCATE_PAGES && run.active; page += 1) {
        const rowId = find();
        if (rowId !== undefined) {
          setFocus({ rowId, nonce: request.nonce });
          setRequest(undefined);
          return;
        }
        const start = transcript.historyStart();
        if (start === undefined || start === 0) break;
        await loadEarlier();
      }
      if (run.active) {
        setRequest(undefined);
        notFound(t('transcript.located'));
      }
    })();
    return () => {
      run.active = false;
    };
  }, [id, request, loading, transcript, loadEarlier, notFound, t]);
  return focus;
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
          transcript.branches.load(window.branches);
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
  covered,
  id,
  modeButton,
  modelButton,
  effortButton,
}: {
  readonly id: string;
  readonly covered: boolean;
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
  // T28: the rewind dialog (at a message, or `/rewind` listing them), text given back for the
  // input (a rewound message, or the message a branch started from).
  const [rewinding, setRewinding] = useState<{ target: RewindTarget | undefined }>();
  const [fill, setFill] = useState<{ text: string; nonce: number }>();
  // T37: the session's slash commands and output styles (Core's `listCommands`), read when
  // the session opens and each time the palette opens; `/output-style` without a name.
  const [commandsList, setCommandsList] = useState<CommandsList>(EMPTY_COMMANDS);
  const [choosingStyle, setChoosingStyle] = useState(false);
  const workspace = session?.workspace;
  const cwd = session?.cwd;
  const refreshCommands = useCallback(() => {
    if (workspace === undefined) return Promise.resolve(EMPTY_COMMANDS);
    return window.piarc
      .listCommands(workspace, cwd ?? null)
      .then((json) => {
        const list = parseCommandsList(json);
        setCommandsList(list);
        return list;
      })
      .catch((failure: unknown) => {
        console.error('[conversation] cannot list the commands', failure);
        return EMPTY_COMMANDS;
      });
  }, [workspace, cwd]);
  useEffect(() => {
    void refreshCommands();
  }, [refreshCommands]);
  // T34: terminal selections attached from the dock become chips in the input.
  const [insert, setInsert] = useState<{ snippets: readonly SnippetData[]; nonce: number }>();
  useEffect(() => {
    const take = () => {
      const snippets = takeSnippets(id);
      if (snippets.length > 0) setInsert({ snippets, nonce: Date.now() + Math.random() });
    };
    take();
    return onSnippet(id, take);
  }, [id]);
  // The rewound message goes into the input when the dialog closes: the dialog gives focus back
  // to what had it (the message's button, gone with the message), the input then takes it.
  const rewoundText = useRef<string | undefined>(undefined);
  useEffect(() => {
    const draft = takeDraft(id);
    if (draft !== undefined) setFill({ text: draft, nonce: Date.now() });
  }, [id]);
  const branchActions = useBranchActions(id, setError);
  const tail = useBranches(id).find((point) => point.turnId === undefined);

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
  const focus = useLocated(id, transcript, history, (text) => {
    ui.addToast({ sessionId: id, text });
  });

  // Shown to the user (the window in front): no longer unread.
  const unread = session?.unread === true;
  const focused = useWindowFocused();
  useEffect(() => {
    if (unread && focused && !covered) {
      window.piarc.markSessionRead(id).catch((failure: unknown) => {
        console.error('[conversation] cannot mark the session read', failure);
      });
    }
  }, [id, unread, focused, covered]);

  const sessionWorkspace = session?.workspace;
  const fileRoot = projectFileRoot(session);
  const fileDirectory = projectPath(session?.cwd ?? '', fileRoot) ?? '';
  const view = useMemo<TranscriptView>(
    () => ({
      services: ui.transcriptServices,
      fileLinks: { sessionId: id, root: fileRoot, directory: fileDirectory },
      transcript,
      actions: {
        retry: (turnId) => {
          void input.retry(turnId);
        },
        resend: (clientId) => {
          void input.resend(clientId);
        },
        rewind: (turnId, text) => {
          setRewinding({ target: { turnId, text } });
        },
        branchFrom: branchActions.branchFrom,
        switchBranch: branchActions.switchBranch,
        // Subagent cards (T31): the child's transcript is read through this session.
        subagentTranscript: (child, start, limit) =>
          window.piarc.subagentTranscript(id, child, start, limit),
        stopSubagent: (child) => {
          window.piarc.stopSubagent(id, child).catch((failure: unknown) => {
            console.error('[conversation] cannot stop the subagent', failure);
          });
        },
        openFile: (raw: string, line?: number) => {
          const path = projectPath(raw, fileRoot, fileDirectory);
          if (path) openProjectFile(id, { path, ...(line === undefined ? {} : { line }) });
          else ui.addToast({ sessionId: id, text: t('files.outside') });
        },
        // A `Memory` call's "Open in settings" (T47): the memory page on this workspace's note.
        openMemory: (note) => {
          if (sessionWorkspace !== undefined) {
            rememberMemoryTarget({
              workspace: sessionWorkspace,
              ...(note === undefined ? {} : { note }),
            });
          }
          window.piarc.openSettings('memory').catch((failure: unknown) => {
            console.error('[conversation] cannot open the memory page', failure);
          });
        },
      },
    }),
    [
      ui,
      transcript,
      input,
      branchActions,
      sessionWorkspace,
      session?.cwd,
      fileRoot,
      fileDirectory,
      id,
      t,
    ],
  );
  const mentions = useMemo(
    () => coreMentions(session?.cwd ?? session?.workspace, ui.composer?.maxSearchResults ?? 20),
    [session?.cwd, session?.workspace, ui.composer?.maxSearchResults],
  );
  // Built-in commands map to features the app already has (ADR-0054 rule 13).
  const runBuiltin = useCallback(
    (action: BuiltinAction, args: string) => {
      const failed = (failure: unknown) => {
        setError(t('composer.failed', { reason: reason(failure) }));
      };
      switch (action) {
        case 'newSession':
          ui.show({ kind: 'home', workspace: session?.workspace });
          break;
        case 'subtask':
          setFill({ text: '/subtask ', nonce: Date.now() + Math.random() });
          break;
        case 'compact':
          window.piarc.compact(id, args === '' ? undefined : args).catch(failed);
          break;
        case 'help':
          ui.openShortcuts();
          break;
        case 'rewind':
          setRewinding({ target: undefined });
          break;
        case 'model':
          ui.runCommand('session.model');
          break;
        case 'context':
          showPanel('context');
          break;
        case 'sideChat':
          ui.runCommand('session.sideChat');
          break;
        case 'outputStyle':
          void refreshCommands().then((list) => {
            if (args === '') {
              setChoosingStyle(true);
            } else if (workspace !== undefined && list.styles.some((s) => s.name === args)) {
              window.piarc.setOutputStyle(workspace, args).catch(failed);
            } else {
              setError(t('outputStyle.unknown', { name: args }));
            }
          });
          break;
        case 'memory':
          // T47: the settings window's memory page, on this session's workspace.
          if (session?.workspace !== undefined)
            rememberMemoryTarget({ workspace: session.workspace });
          window.piarc.openSettings('memory').catch(failed);
          break;
      }
    },
    [ui, session?.workspace, id, t, refreshCommands, workspace],
  );
  // A slash command chosen in the Mod+K palette for this session.
  useEffect(() => {
    const take = () => {
      const name = takeCommand(id);
      if (name === undefined) return;
      const known = builtin(name);
      if (known === undefined) setFill({ text: `/${name} `, nonce: Date.now() + Math.random() });
      else runBuiltin(known.action, '');
    };
    take();
    return onCommandRequest((sessionId) => {
      if (sessionId === id) take();
    });
  }, [id, runBuiltin]);
  const runCommand = useCallback(
    (command: PaletteCommand) => {
      const known = builtin(command.name);
      if (known !== undefined) runBuiltin(known.action, '');
    },
    [runBuiltin],
  );
  const handlers = useMemo<ComposerHandlers>(
    () => ({
      submit(intent, submission) {
        setError(undefined);
        const draft = draftOf(submission);
        const plain =
          draft.mentions.length === 0 && draft.pending.length === 0 && draft.stored.length === 0;
        const typed = plain ? typedBuiltin(draft.text) : undefined;
        if (typed !== undefined && typed.action !== 'compact' && typed.action !== 'subtask') {
          runBuiltin(typed.action, typed.args);
          return true;
        }
        const focus = compactFocus(draft);
        if (focus !== undefined) {
          window.piarc.compact(id, focus === '' ? undefined : focus).catch((failure: unknown) => {
            setError(t('composer.failed', { reason: reason(failure) }));
          });
          return true;
        }
        if (intent === 'send') {
          void input.send(draft);
          return true;
        }
        input.add(intent === 'steer' ? 'steer' : 'followUp', draft).catch((failure: unknown) => {
          setError(t('composer.failed', { reason: reason(failure) }));
        });
        return true;
      },
      stop() {
        window.piarc.abort(id).catch((failure: unknown) => {
          console.error('[conversation] cannot stop the turn', failure);
        });
      },
      command: () => {
        void refreshCommands();
      },
      runCommand,
      mentionOpened: () => undefined,
      mentionChosen: () => undefined,
    }),
    [input, id, t, runCommand, runBuiltin, refreshCommands],
  );

  // The transcript's view (T29), remembered per session in this window.
  const detail = useSessionDetail(id);
  const empty = !history.loading && !transcript.hasContent();
  return (
    <section className="conversation" data-testid="conversation" data-session-id={id}>
      <DetailContext.Provider value={detail}>
        <TranscriptContext.Provider value={view}>
          <div className="conversation-body">
            {history.loading && !transcript.hasContent() ? (
              <p className="muted conversation-note">{t('conversation.loading')}</p>
            ) : null}
            {empty ? <p className="muted conversation-note">{t('conversation.empty')}</p> : null}
            <Transcript
              onReachTop={history.loadEarlier}
              loadingEarlier={history.loadingEarlier}
              focus={focus}
            />
            <LiveRegion />
          </div>
        </TranscriptContext.Provider>
      </DetailContext.Provider>
      <div className="conversation-composer">
        <NoticeBar />
        <Composer
          sessionId={id}
          fileScope={{ root: fileRoot, directory: fileDirectory }}
          savedDraft={store.editorDraft('session', id)}
          running={turn.running}
          handlers={handlers}
          mentions={mentions}
          commands={commandsList.commands}
          limits={ui.composer?.limits}
          supportsImages={model?.vision}
          error={
            error ?? (catalogFailure ? t('models.failed', { reason: catalogFailure }) : undefined)
          }
          fill={fill}
          insert={insert}
          above={
            queue.length === 0 ? (
              tail === undefined ? null : (
                <BranchTail
                  point={tail}
                  onSwitch={branchActions.switchBranch}
                  disabled={turn.running}
                />
              )
            ) : (
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
          {session?.worktreeName !== undefined && (
            <span
              className="tag worktree-tag"
              data-testid="env-worktree"
              title={t('env.worktreeTitle', {
                path: session.worktreePath ?? '',
                branch: session.worktreeBranch ?? '',
              })}
            >
              {t('env.worktree', { name: session.worktreeName })}
              {session.worktreeBranch === undefined ? null : ` · ${session.worktreeBranch}`}
            </span>
          )}
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
          <AutoReviewStatus
            state={session?.open === true ? session.autoReviewState : undefined}
            reason={session?.autoReviewReason}
          />
          <SandboxStatus workspace={workspace} />
          <UsageRing sessionId={id} />
        </div>
      </div>
      {choosingStyle && workspace !== undefined ? (
        <OutputStyleDialog
          styles={commandsList.styles}
          current={commandsList.style}
          onChoose={(name) => {
            setChoosingStyle(false);
            window.piarc
              .setOutputStyle(workspace, name)
              .then(() => refreshCommands())
              .catch((failure: unknown) => {
                setError(t('composer.failed', { reason: reason(failure) }));
              });
          }}
          onClose={() => {
            setChoosingStyle(false);
          }}
        />
      ) : null}
      {rewinding === undefined ? null : (
        <RewindDialog
          sessionId={id}
          target={rewinding.target}
          turns={transcript.userTurns()}
          onDone={(report) => {
            const text = report.conversation?.text;
            if (text != null) rewoundText.current = text;
            void transcript.changes.refresh(() => window.piarc.sessionChanges(id));
          }}
          onClose={() => {
            setRewinding(undefined);
            const text = rewoundText.current;
            rewoundText.current = undefined;
            if (text !== undefined) setFill({ text, nonce: Date.now() });
          }}
        />
      )}
    </section>
  );
}
