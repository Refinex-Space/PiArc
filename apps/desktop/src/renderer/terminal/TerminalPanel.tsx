// The terminal panel (T34, architecture section 8.2): the dock's tabs of the session's
// terminals, the user's and the agent's (terminal tasks, ADR-0050), each in the session's
// directory. A tab follows its program's title unless the person renamed it; closing it ends
// the shell and everything it started. The toolbar shares a user's terminal with the agent
// (off by default), finds text, shows the screen as text (for screen readers), and adds the
// selection to the message. Terminals belong to the session in Core: the panel only views
// them, so a reload or closing the panel leaves them running.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BackgroundTask } from '@piarc/protocol';
import type { TerminalMatchInfo } from '../../shared/ipc.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import {
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  TerminalIcon,
} from '../shell/icons.js';
import { MenuButton } from '../shell/Menu.js';
import { ToolHeaderContent } from '../shell/ToolHeaderSlot.js';
import { TerminalTabs, type TerminalTab as Tab } from './TerminalTabs.js';
import { useT } from '../app/app-context.js';
import { attachSnippet } from '../composer/snippets.js';
import { Dialog } from '../shell/Dialog.js';
import { useTasks } from '../store/hooks.js';
import type { TerminalController } from './controller.js';
import { onTerminalEvents } from './events.js';
import {
  setActiveTerminal,
  takeTerminalWish,
  useActiveTerminal,
  useTerminalFocusRequest,
  useTerminalNames,
} from './panel-state.js';
import { scrollFor, step } from './search.js';
import { TerminalSurface, type SurfaceHandlers } from './TerminalSurface.js';

function tabsOf(tasks: readonly BackgroundTask[], sessionId: string): Tab[] {
  return tasks
    .filter(
      (task) =>
        task.kind === 'terminal' &&
        task.status === 'running' &&
        task.ownerSessionId === sessionId &&
        typeof task.terminal?.terminalId === 'number',
    )
    .map((task) => ({
      taskId: task.taskId,
      terminalId: task.terminal?.terminalId ?? 0,
      agent: task.terminal?.origin === 'agent',
      shared: task.terminal?.shared === true,
      startedAt: task.startedAt,
    }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Titles the programs set, per terminal id. */
function useTitles(tabs: readonly Tab[]): Readonly<Record<number, string>> {
  const [titles, setTitles] = useState<Readonly<Record<number, string>>>({});
  const ids = tabs.map((tab) => tab.terminalId).join(',');
  useEffect(() => {
    const stops = ids
      .split(',')
      .filter((id) => id !== '')
      .map(Number)
      .map((id) => {
        // The current title first (after a reload no event repeats it), then its changes.
        window.piarc
          .terminalInfo(id)
          .then((info) => {
            setTitles((current) => ({ ...current, [id]: info.title }));
          })
          .catch(() => undefined);
        return onTerminalEvents(id, (event) => {
          if (event.type === 'title') {
            setTitles((current) => ({ ...current, [id]: event.title }));
          }
        });
      });
    return () => {
      for (const stop of stops) stop();
    };
  }, [ids]);
  return titles;
}

/** The program's title, or `fallback` when it set none. */
function titleOr(title: string | undefined, fallback: string): string {
  return title === undefined || title === '' ? fallback : title;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TerminalPanel({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const tasks = useTasks();
  const [opened, setOpened] = useState<readonly Tab[]>([]);
  const fromTasks = useMemo(() => tabsOf(tasks, sessionId), [tasks, sessionId]);
  // Core takes over the optimistic tab as soon as it publishes a handle or a final status.
  const confirmed = useMemo(
    () =>
      new Set(
        tasks
          .filter((task) => task.status !== 'running' || task.terminal?.terminalId !== undefined)
          .map((task) => task.taskId),
      ),
    [tasks],
  );
  useEffect(() => {
    if (opened.some((tab) => confirmed.has(tab.taskId))) {
      setOpened((current) => current.filter((tab) => !confirmed.has(tab.taskId)));
    }
  }, [opened, confirmed]);
  const tabs = useMemo(
    () => [...fromTasks, ...opened.filter((tab) => !confirmed.has(tab.taskId))],
    [fromTasks, opened, confirmed],
  );
  const names = useTerminalNames();
  const titles = useTitles(tabs);
  const activeId = useActiveTerminal(sessionId);
  const active = tabs.find((tab) => tab.taskId === activeId) ?? tabs[tabs.length - 1];
  const focusRequest = useTerminalFocusRequest(sessionId);
  const [focusNonce, setFocusNonce] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  /** A short note for everyone, screen readers too (copied, attached). */
  const [status, setStatus] = useState('');
  const [opening, setOpening] = useState(false);
  const view = useRef<TerminalController | null>(null);
  const [hasView, setHasView] = useState(false);
  const [finding, setFinding] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [screenText, setScreenText] = useState<{ terminalId: number; text: string }>();
  const textRequest = useRef(0);
  const [paste, setPaste] = useState<{ text: string; resolve: (ok: boolean) => void }>();

  const nameOf = (tab: Tab, index: number): string =>
    names[tab.taskId] ??
    titleOr(titles[tab.terminalId], t('terminal.defaultName', { n: index + 1 }));

  const openTerminal = useCallback(() => {
    setOpening(true);
    setError(undefined);
    window.piarc
      .openSessionTerminal(sessionId, { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 })
      .then((terminal) => {
        setOpened((list) => [
          ...list,
          {
            taskId: terminal.taskId,
            terminalId: terminal.terminalId,
            agent: false,
            shared: false,
            startedAt: Date.now(),
          },
        ]);
        setActiveTerminal(sessionId, terminal.taskId);
        setFocusNonce((n) => n + 1);
      })
      .catch((reason: unknown) => {
        setError(t('terminal.openFailed', { reason: message(reason) }));
      })
      .finally(() => {
        setOpening(false);
      });
  }, [sessionId, t]);

  // Ctrl+` on a session without a terminal opens one; any request moves the focus in.
  useEffect(() => {
    if (focusRequest === 0) return;
    if (takeTerminalWish(sessionId) && tabs.length === 0 && !opening) {
      openTerminal();
    } else {
      setFocusNonce((n) => n + 1);
    }
    // Only a new request counts, not new tabs.
  }, [focusRequest]);

  const onController = useCallback((controller: TerminalController | null) => {
    view.current = controller;
    setHasView(controller !== null);
  }, []);

  const handlers = useMemo<SurfaceHandlers>(
    () => ({
      openLink: (uri) => {
        // The main process shows the address and asks before opening it.
        void window.piarc.openExternal(uri);
      },
      confirmPaste: (text) =>
        new Promise<boolean>((resolve) => {
          setPaste({ text, resolve });
        }),
      copied: () => {
        setStatus(t('terminal.copied'));
      },
    }),
    [t],
  );

  const attachSelection = async () => {
    const controller = view.current;
    if (controller === null || active === undefined) return;
    const text = await controller.selectionText();
    if (text === '') {
      setStatus(t('terminal.nothingSelected'));
      return;
    }
    const name = nameOf(active, tabs.indexOf(active));
    attachSnippet(sessionId, {
      label: t('terminal.snippetLabel', { name, lines: text.split('\n').length }),
      source: `Terminal ${name}`,
      text,
    });
    setStatus(t('terminal.attached'));
  };

  const share = (tab: Tab) => {
    window.piarc.shareTerminal(tab.terminalId, !tab.shared).then(
      () => {
        setOpened((list) =>
          list.map((entry) =>
            entry.taskId === tab.taskId ? { ...entry, shared: !tab.shared } : entry,
          ),
        );
      },
      (reason: unknown) => {
        setError(t('terminal.shareFailed', { reason: message(reason) }));
      },
    );
  };

  const closeTab = (tab: Tab) => {
    window.piarc.closeTerminal(tab.terminalId).then(
      () => {
        setOpened((list) => list.filter((entry) => entry.taskId !== tab.taskId));
      },
      (reason: unknown) => {
        setError(message(reason));
      },
    );
  };

  const showText = () => {
    if (active === undefined) return;
    const request = ++textRequest.current;
    window.piarc.terminalScreenText(active.terminalId).then(
      (text) => {
        if (textRequest.current === request) setScreenText({ terminalId: active.terminalId, text });
      },
      (reason: unknown) => {
        if (textRequest.current === request) setError(message(reason));
      },
    );
  };

  return (
    <div
      className="terminal-panel workbench-terminal"
      data-testid="terminal-panel"
      onKeyDown={(event) => {
        // ⌘F on macOS reaches here (⌘ keys stay with the app); elsewhere use the button.
        if (
          !isImeComposing(event.nativeEvent) &&
          event.metaKey &&
          event.code === 'KeyF' &&
          active !== undefined
        ) {
          event.preventDefault();
          setFinding(true);
          findInput.current?.focus();
        }
      }}
    >
      <ToolHeaderContent>
        <div className="terminal-tabs">
          <TerminalTabs
            tabs={tabs}
            active={active}
            nameOf={nameOf}
            onSelect={(tab, focusShell) => {
              setActiveTerminal(sessionId, tab.taskId);
              setFocusNonce((n) => (focusShell ? n + 1 : 0));
              setScreenText(undefined);
              textRequest.current++;
            }}
            onClose={closeTab}
          />
          <IconButton
            className="terminal-add"
            label={t('terminal.new')}
            disabled={opening}
            onClick={openTerminal}
            data-testid="terminal-new"
          >
            <PlusIcon />
          </IconButton>
          {active && (
            <div className="terminal-actions">
              {active.agent ? (
                <span className="terminal-agent-note" title={t('terminal.agentOwned')}>
                  {t('terminal.agentBadge')}
                </span>
              ) : (
                <button
                  className="terminal-share-state"
                  type="button"
                  role="switch"
                  aria-checked={active.shared}
                  aria-label={
                    t(active.shared ? 'terminal.shared' : 'terminal.private') +
                    ' · ' +
                    t('terminal.share')
                  }
                  aria-description={t('terminal.shareHint')}
                  title={t('terminal.shareHint')}
                  data-testid="terminal-share"
                  onClick={() => {
                    share(active);
                  }}
                >
                  <span className="terminal-share-indicator" aria-hidden="true" />
                  <span className="terminal-share-label">
                    {t(active.shared ? 'terminal.shared' : 'terminal.private')}
                  </span>
                </button>
              )}
              <IconButton
                label={t('terminal.findLabel')}
                aria-expanded={finding}
                data-testid="terminal-find"
                onClick={() => {
                  setFinding(!finding);
                  if (finding) {
                    view.current?.setMatches([], undefined);
                    view.current?.focus();
                  }
                }}
              >
                <SearchIcon />
              </IconButton>
              <MenuButton
                label={t('terminal.actions')}
                testId="terminal-actions"
                items={[
                  {
                    id: 'attach',
                    label: t('terminal.attach'),
                    testId: 'terminal-attach',
                    icon: <PaperclipIcon />,
                    disabled: !hasView,
                    run: () => {
                      void attachSelection().catch((failure: unknown) => {
                        setError(message(failure));
                      });
                    },
                  },
                  {
                    id: 'text',
                    label: t('terminal.viewText'),
                    testId: 'terminal-view-text',
                    icon: <FileIcon />,
                    run: showText,
                  },
                ]}
              >
                <MoreIcon />
              </MenuButton>
            </div>
          )}
        </div>
      </ToolHeaderContent>
      {active === undefined ? (
        <div className="terminal-empty">
          <TerminalIcon />
          <p>{t('terminal.empty')}</p>
          <Button size="small" onClick={openTerminal} loading={opening}>
            {t('terminal.new')}
          </Button>
        </div>
      ) : (
        <>
          {finding ? (
            <FindBar
              input={findInput}
              terminalId={active.terminalId}
              view={view}
              onClose={() => {
                setFinding(false);
                view.current?.setMatches([], undefined);
                view.current?.focus();
              }}
            />
          ) : null}
          <TerminalSurface
            key={active.terminalId}
            terminalId={active.terminalId}
            label={t('terminal.inputLabel', { name: nameOf(active, tabs.indexOf(active)) })}
            handlers={handlers}
            onController={onController}
            focusNonce={focusNonce}
          />
        </>
      )}
      <p className="terminal-status muted" role="status" data-testid="terminal-status">
        {status}
      </p>
      {error === undefined ? null : (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      {screenText === undefined || screenText.terminalId !== active?.terminalId ? null : (
        <ScreenText
          name={nameOf(active, tabs.indexOf(active))}
          text={screenText.text}
          onRefresh={showText}
          onClose={() => {
            textRequest.current++;
            setScreenText(undefined);
          }}
        />
      )}
      {paste === undefined ? null : (
        <Dialog
          labelledBy="terminal-paste-title"
          testId="terminal-paste-dialog"
          onCancel={() => {
            paste.resolve(false);
            setPaste(undefined);
          }}
        >
          <h2 id="terminal-paste-title">{t('terminal.pasteTitle')}</h2>
          <p>{t('terminal.pasteBody')}</p>
          <pre className="terminal-paste-preview">{paste.text}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                paste.resolve(false);
                setPaste(undefined);
              }}
            >
              {t('terminal.cancel')}
            </button>
            <button
              type="button"
              className="button button-primary"
              data-testid="terminal-paste-confirm"
              onClick={() => {
                paste.resolve(true);
                setPaste(undefined);
              }}
            >
              {t('terminal.pasteConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** The find bar: matches from Core, highlighted in the view, stepped through. */
function FindBar({
  input,
  terminalId,
  view,
  onClose,
}: {
  readonly input: React.RefObject<HTMLInputElement | null>;
  readonly terminalId: number;
  readonly view: React.RefObject<TerminalController | null>;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<readonly TerminalMatchInfo[]>([]);
  const [current, setCurrent] = useState<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      window.piarc.terminalSearch(terminalId, query).then(
        (found) => {
          if (!live) return;
          setMatches(found);
          setCurrent(found.length === 0 ? undefined : 0);
        },
        () => {
          if (live) setMatches([]);
        },
      );
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [terminalId, query]);

  useEffect(() => {
    const controller = view.current;
    if (controller === null) return;
    controller.setMatches(matches, current);
    const match = current === undefined ? undefined : matches[current];
    if (match !== undefined) {
      const row = scrollFor(match, controller.viewport);
      if (row !== undefined) controller.scroll({ kind: 'row', row });
    }
  }, [matches, current, view]);

  const go = (direction: 1 | -1) => {
    setCurrent((index) => step(matches.length, index, direction));
  };

  return (
    <div
      className="terminal-find"
      role="search"
      data-testid="terminal-find-bar"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeComposing(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <SearchIcon />
      <input
        ref={input}
        className="terminal-find-input"
        aria-label={t('terminal.findLabel')}
        placeholder={t('terminal.findLabel')}
        value={query}
        autoFocus
        data-testid="terminal-find-input"
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            // Up the screen (older) by default, as the search starts from the bottom.
            go(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="terminal-find-count" aria-live="polite" data-testid="terminal-find-count">
        {query === ''
          ? ''
          : matches.length === 0
            ? t('terminal.noMatches')
            : t('terminal.matches', { current: (current ?? 0) + 1, count: matches.length })}
      </span>
      <IconButton
        label={t('terminal.findPrevious')}
        disabled={!matches.length}
        onClick={() => {
          go(1);
        }}
        data-testid="terminal-find-previous"
      >
        <span className="terminal-up">
          <ChevronDownIcon />
        </span>
      </IconButton>
      <IconButton
        label={t('terminal.findNext')}
        disabled={!matches.length}
        onClick={() => {
          go(-1);
        }}
        data-testid="terminal-find-next"
      >
        <ChevronDownIcon />
      </IconButton>
      <IconButton label={t('terminal.findClose')} onClick={onClose}>
        <CloseIcon />
      </IconButton>
    </div>
  );
}

/** The screen as text from Core's formatter, for screen readers and copying. */
function ScreenText({
  name,
  text,
  onRefresh,
  onClose,
}: {
  readonly name: string;
  readonly text: string;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog labelledBy="terminal-text-title" onCancel={onClose} testId="terminal-text-dialog" wide>
      <h2 className="dialog-title" id="terminal-text-title">
        {t('terminal.viewTextTitle', { name })}
      </h2>
      <pre
        className="terminal-screen-text"
        tabIndex={0}
        aria-labelledby="terminal-text-title"
        data-autofocus
        data-testid="terminal-screen-text"
      >
        {text}
      </pre>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onRefresh}>
          {t('terminal.refresh')}
        </Button>
        <Button variant="primary" onClick={onClose}>
          {t('terminal.closeDialog')}
        </Button>
      </div>
    </Dialog>
  );
}
