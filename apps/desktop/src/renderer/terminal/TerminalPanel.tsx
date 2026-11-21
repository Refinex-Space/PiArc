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
import { useT } from '../app/app-context.js';
import { attachSnippet } from '../composer/snippets.js';
import { Dialog } from '../shell/Dialog.js';
import { useTasks } from '../store/hooks.js';
import type { TerminalController } from './controller.js';
import { onTerminalEvents } from './events.js';
import {
  renameTerminal,
  setActiveTerminal,
  takeTerminalWish,
  useActiveTerminal,
  useTerminalFocusRequest,
  useTerminalNames,
} from './panel-state.js';
import { scrollFor, step } from './search.js';
import { TerminalSurface, type SurfaceHandlers } from './TerminalSurface.js';

/** A terminal the panel shows: from the task snapshot, or just opened (before the snapshot). */
interface Tab {
  readonly taskId: string;
  readonly terminalId: number;
  readonly agent: boolean;
  readonly shared: boolean;
  readonly startedAt: number;
}

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
  // A terminal just opened shows before the next task snapshot lists it.
  const tabs = useMemo(() => {
    const known = new Set(fromTasks.map((tab) => tab.taskId));
    return [...fromTasks, ...opened.filter((tab) => !known.has(tab.taskId))];
  }, [fromTasks, opened]);
  const names = useTerminalNames();
  const titles = useTitles(tabs);
  const activeId = useActiveTerminal(sessionId);
  const active = tabs.find((tab) => tab.taskId === activeId) ?? tabs[tabs.length - 1];
  const focusRequest = useTerminalFocusRequest();
  const [focusNonce, setFocusNonce] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  /** A short note for everyone, screen readers too (copied, attached). */
  const [status, setStatus] = useState('');
  const [opening, setOpening] = useState(false);
  const view = useRef<TerminalController | null>(null);
  const [hasView, setHasView] = useState(false);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const [screenText, setScreenText] = useState<string | undefined>(undefined);
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
    if (takeTerminalWish() && tabs.length === 0 && !opening) {
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

  const showText = () => {
    if (active === undefined) return;
    window.piarc.terminalScreenText(active.terminalId).then(setScreenText, (reason: unknown) => {
      setError(message(reason));
    });
  };

  return (
    <div
      className="terminal-panel"
      data-testid="terminal-panel"
      onKeyDown={(event) => {
        // ⌘F on macOS reaches here (⌘ keys stay with the app); elsewhere use the button.
        if (event.metaKey && event.code === 'KeyF' && active !== undefined) {
          event.preventDefault();
          setFinding(true);
        }
      }}
    >
      <div className="terminal-tabs" role="tablist" aria-label={t('panel.terminal')}>
        {tabs.map((tab, index) => {
          const name = nameOf(tab, index);
          const selected = tab === active;
          return (
            <div key={tab.taskId} className={`terminal-tab${selected ? ' is-active' : ''}`}>
              {renaming === tab.taskId ? (
                <input
                  className="terminal-tab-rename"
                  aria-label={t('terminal.renameLabel')}
                  defaultValue={name}
                  data-autofocus
                  ref={(input) => {
                    input?.focus();
                  }}
                  data-testid="terminal-rename"
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                      renameTerminal(tab.taskId, event.currentTarget.value);
                      setRenaming(undefined);
                    } else if (event.key === 'Escape') {
                      setRenaming(undefined);
                    }
                  }}
                  onBlur={(event) => {
                    renameTerminal(tab.taskId, event.currentTarget.value);
                    setRenaming(undefined);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="terminal-tab-name"
                  data-testid="terminal-tab"
                  data-task={tab.taskId}
                  data-terminal={tab.terminalId}
                  title={t('terminal.rename', { name })}
                  onClick={() => {
                    setActiveTerminal(sessionId, tab.taskId);
                    setFocusNonce((n) => n + 1);
                  }}
                  onDoubleClick={() => {
                    setRenaming(tab.taskId);
                  }}
                >
                  {name}
                  {tab.agent ? (
                    <span className="terminal-tab-badge">{t('terminal.agentBadge')}</span>
                  ) : null}
                </button>
              )}
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={t('terminal.close', { name })}
                data-testid="terminal-tab-close"
                onClick={() => {
                  window.piarc.closeTerminal(tab.terminalId).catch((reason: unknown) => {
                    setError(message(reason));
                  });
                  setOpened((list) => list.filter((entry) => entry.taskId !== tab.taskId));
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="terminal-new"
          disabled={opening}
          onClick={openTerminal}
          aria-label={t('terminal.new')}
          title={t('terminal.new')}
          data-testid="terminal-new"
        >
          +
        </button>
      </div>
      {active === undefined ? (
        <div className="terminal-empty">
          <p className="muted">{t('terminal.empty')}</p>
          <button type="button" className="button" onClick={openTerminal} disabled={opening}>
            {t('terminal.new')}
          </button>
        </div>
      ) : (
        <>
          <div className="terminal-toolbar">
            {active.agent ? (
              <span className="muted terminal-agent-note">{t('terminal.agentOwned')}</span>
            ) : (
              <label className="terminal-share" title={t('terminal.shareHint')}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={active.shared}
                  onChange={() => {
                    share(active);
                  }}
                  data-testid="terminal-share"
                />
                {t('terminal.share')}
              </label>
            )}
            <span className="terminal-toolbar-gap" />
            <button
              type="button"
              className="button"
              disabled={!hasView}
              onClick={() => void attachSelection()}
              data-testid="terminal-attach"
            >
              {t('terminal.attach')}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setFinding(true);
              }}
              data-testid="terminal-find"
            >
              {t('terminal.find')}
            </button>
            <button
              type="button"
              className="button"
              onClick={showText}
              data-testid="terminal-view-text"
            >
              {t('terminal.viewText')}
            </button>
          </div>
          {finding ? (
            <FindBar
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
      {screenText === undefined || active === undefined ? null : (
        <ScreenText
          name={nameOf(active, tabs.indexOf(active))}
          text={screenText}
          onRefresh={showText}
          onClose={() => {
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
  terminalId,
  view,
  onClose,
}: {
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
    <div className="terminal-find" role="search" data-testid="terminal-find-bar">
      <input
        className="terminal-find-input"
        aria-label={t('terminal.findLabel')}
        placeholder={t('terminal.findLabel')}
        value={query}
        ref={(input) => {
          input?.focus();
        }}
        data-testid="terminal-find-input"
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            // Up the screen (older) by default, as the search starts from the bottom.
            go(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
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
      <button
        type="button"
        className="button"
        aria-label={t('terminal.findPrevious')}
        onClick={() => {
          go(1);
        }}
        data-testid="terminal-find-previous"
      >
        ↑
      </button>
      <button
        type="button"
        className="button"
        aria-label={t('terminal.findNext')}
        onClick={() => {
          go(-1);
        }}
        data-testid="terminal-find-next"
      >
        ↓
      </button>
      <button
        type="button"
        className="button"
        aria-label={t('terminal.findClose')}
        onClick={onClose}
      >
        ×
      </button>
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
      <h2 id="terminal-text-title">{t('terminal.viewTextTitle', { name })}</h2>
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
        <button type="button" className="button" onClick={onRefresh}>
          {t('terminal.refresh')}
        </button>
        <button type="button" className="button button-primary" onClick={onClose}>
          {t('terminal.closeDialog')}
        </button>
      </div>
    </Dialog>
  );
}
