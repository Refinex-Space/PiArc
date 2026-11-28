// Global search: one keyboard-first dialog for sessions, projects, indexed messages, the
// registered commands (Mod+K, architecture section 8.5, T37) with the current session's slash
// commands, and the keyboard shortcuts (Mod+/, `/help`). Tabs narrow it; the query filters every
// tab with the `/` palette's fuzzy matcher. Keys go through the input method guard.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { fuzzyFilter } from '../../shared/fuzzy.js';
import type { AppCommand } from '../../shared/ipc.js';
import { COMMANDS, effectiveBindings, type CommandId } from '../../shared/keybindings.js';
import { IconButton } from '../app/IconButton.js';
import { Keycaps } from '../app/Keycaps.js';
import { useApp } from '../app/app-context.js';
import { BUILTIN_NAMES, builtin } from '../composer/builtins.js';
import { parseCommandsList } from '../composer/commands-list.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSessions, useWorkspaces } from '../store/hooks.js';
import { Dialog } from './Dialog.js';
import {
  CloseIcon,
  CommandIcon,
  FolderIcon,
  GearIcon,
  ReturnIcon,
  SearchIcon,
  SideChatIcon,
} from './icons.js';
import { MessageSearch } from './MessageSearch.js';
import { sessionTitle } from './SessionRow.js';
import { baseName } from './ui.js';

export type SearchTab = 'all' | 'session' | 'project' | 'commands' | 'shortcuts';
type When = 'today' | 'week' | 'month';
const DAY = 24 * 60 * 60 * 1000;

function dateFloor(when: When | null): number | null {
  const now = Date.now();
  if (when === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (when === 'week') return now - 7 * DAY;
  if (when === 'month') return now - 30 * DAY;
  return null;
}

type T = ReturnType<typeof useApp>['t'];

function whenLabel(ms: number | undefined, t: T): string | null {
  if (ms === undefined || ms <= 0) return null;
  const now = Date.now();
  const minutes = (now - ms) / 60000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (minutes < 5) return t('nav.when.justNow');
  if (minutes < 60) return t('nav.when.pastHour');
  if (ms >= start.getTime()) return t('nav.when.today');
  if (ms >= start.getTime() - DAY) return t('nav.when.yesterday');
  const days = (now - ms) / DAY;
  if (days < 7) return t('nav.when.pastWeek');
  if (days < 30) return t('nav.when.pastMonth');
  if (days < 365) return t('nav.when.pastYear');
  return null;
}

/** The current session's slash commands, listed by Core for its workspace and directory. */
function useSlashCommands(
  current:
    { readonly workspace?: string | undefined; readonly cwd?: string | undefined } | undefined,
  t: T,
) {
  const [slash, setSlash] = useState<readonly { name: string; description: string }[]>([]);
  useEffect(() => {
    if (current?.workspace === undefined) return;
    let live = true;
    window.piarc
      .listCommands(current.workspace, current.cwd ?? null)
      .then((json) => {
        if (!live) return;
        setSlash(
          parseCommandsList(json).commands.map((c) => {
            const label = builtin(c.name)?.label;
            return { name: c.name, description: label === undefined ? c.description : t(label) };
          }),
        );
      })
      .catch((failure: unknown) => {
        console.error('[search] cannot list the commands', failure);
      });
    return () => {
      live = false;
    };
  }, [current?.workspace, current?.cwd, t]);
  return slash;
}

export function GlobalSearch({
  tab,
  onTab,
  current,
  run,
  open,
  command,
  onClose,
}: {
  readonly tab: SearchTab;
  readonly onTab: (tab: SearchTab) => void;
  /** The session shown, whose slash commands are listed. */
  readonly current:
    | {
        readonly id: string;
        readonly workspace?: string | undefined;
        readonly cwd?: string | undefined;
      }
    | undefined;
  /** Runs a registered command. */
  readonly run: (command: AppCommand) => void;
  /** Shows a session or a project's new-session view. */
  readonly open: (target: { session: string } | { project: string }) => void;
  /** Sends a slash command to the current session. */
  readonly command: (name: string) => void;
  readonly onClose: () => void;
}) {
  const { t, preferences, keyPlatform } = useApp();
  const sessions = useSessions();
  const workspaces = useWorkspaces();
  const title = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [when, setWhen] = useState<When | null>(null);
  const [selected, setSelected] = useState(0);
  const slash = useSlashCommands(current, t);
  const bindings = effectiveBindings(preferences.keybindings);
  const needle = query.trim().toLowerCase();
  const dated = tab === 'all' || tab === 'session' || tab === 'project';
  const floor = dated ? dateFloor(when) : null;
  const fresh = (at: number | undefined) => floor === null || (at ?? 0) >= floor;
  const untitled = t('session.untitled');
  const projectNames = new Map(workspaces.map((w) => [w.path, w.displayName]));
  const activity = new Map<string, number>();
  for (const session of sessions) {
    const path = session.workspace ?? session.cwd ?? '';
    const at = session.updatedAt ?? session.createdAt ?? 0;
    activity.set(path, Math.max(activity.get(path) ?? 0, at));
  }

  // Archived sessions are found by name; browsing lists the active ones.
  const sessionRows = sessions
    .filter((s) => !s.archived || needle !== '')
    .filter((s) => fresh(s.updatedAt ?? s.createdAt))
    .filter((s) => {
      const path = s.workspace ?? s.cwd ?? '';
      return (
        !needle ||
        sessionTitle(s.title, untitled).toLowerCase().includes(needle) ||
        (projectNames.get(path) ?? baseName(path)).toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, tab === 'session' ? 50 : 8);
  const projectRows = workspaces
    .filter((p) => fresh(activity.get(p.path)))
    .filter(
      (p) =>
        !needle ||
        p.displayName.toLowerCase().includes(needle) ||
        p.path.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        (activity.get(b.path) ?? 0) - (activity.get(a.path) ?? 0) ||
        a.displayName.localeCompare(b.displayName),
    )
    .slice(0, tab === 'project' ? 50 : 5);
  const actions = useMemo(() => COMMANDS.filter((c) => c.id !== 'app.commandPalette'), []);
  const actionRows = fuzzyFilter(actions, query, (c) => [t(c.label)]).slice(
    0,
    tab === 'all' ? 6 : undefined,
  );
  const slashRows =
    current === undefined
      ? []
      : fuzzyFilter(slash, query, (c) => [`/${c.name}`, c.description]).slice(
          0,
          tab === 'all' ? 6 : undefined,
        );
  const shortcutRows = fuzzyFilter([...COMMANDS], query, (c) => [t(c.label)]);
  const builtinRows = fuzzyFilter([...BUILTIN_NAMES], query, (name) => {
    const label = builtin(name)?.label;
    return [name, label === undefined ? '' : t(label)];
  });

  const showSessions = tab === 'all' || tab === 'session';
  const showProjects = tab === 'all' || tab === 'project';
  const showActions = tab === 'commands' || (tab === 'all' && needle !== '');
  const showShortcuts = tab === 'shortcuts';

  useEffect(() => {
    setSelected(0);
  }, [needle, tab, when]);
  useEffect(() => {
    input.current?.focus();
  }, [tab]);

  const close = (then: () => void) => () => {
    onClose();
    then();
  };
  const runAction = (id: CommandId) =>
    close(() => {
      run(id);
    });
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    const options = Array.from(
      results.current?.querySelectorAll<HTMLButtonElement>('.search-destination:not(:disabled)') ??
        [],
    );
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return;
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? (selected + 1) % options.length
          : (selected - 1 + options.length) % options.length;
      setSelected(next);
      options[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      options[selected]?.click();
    }
  };

  const tabs = [
    ['all', 'nav.searchAll'],
    ['session', 'sidebar.label'],
    ['project', 'nav.projects'],
    ['commands', 'nav.searchCommands'],
    ['shortcuts', 'nav.searchShortcuts'],
  ] as const;
  const dates = [
    ['today', 'nav.filterToday'],
    ['week', 'nav.filterWeek'],
    ['month', 'nav.filterMonth'],
  ] as const;
  let option = 0;
  /** Props shared by every selectable row. */
  const row = (testId: string, onClick: () => void, disabled = false) => {
    const index = disabled ? -1 : option++;
    const active = index === selected;
    return {
      active,
      props: {
        type: 'button' as const,
        className: `search-destination${active ? ' is-selected' : ''}`,
        'data-testid': testId,
        disabled,
        onMouseMove: () => {
          if (!disabled) setSelected(index);
        },
        onMouseDown: (event: React.MouseEvent) => {
          event.preventDefault();
        },
        onClick,
      },
    };
  };
  const keys = (binding: string | undefined) =>
    binding ? (
      <Keycaps binding={binding} platform={keyPlatform} />
    ) : (
      <span className="workspace-search-meta">{t('settings.shortcuts.unbound')}</span>
    );

  const nothing =
    (showSessions ? sessionRows.length : 0) +
      (showProjects ? projectRows.length : 0) +
      (showActions ? actionRows.length + slashRows.length : 0) +
      (showShortcuts ? shortcutRows.length + builtinRows.length : 0) ===
    0;

  return createPortal(
    <Dialog labelledBy={title} onCancel={onClose} testId="global-search" wide dismissOnBackdrop>
      <div className="workspace-search-content" data-tab={tab} onKeyDown={navigate}>
        <h2 id={title} className="visually-hidden">
          {t('nav.search')}
        </h2>
        <div className="workspace-search-field">
          <SearchIcon />
          <input
            ref={input}
            type="search"
            className="input"
            data-autofocus
            data-testid="global-search-input"
            value={query}
            autoComplete="off"
            aria-label={t('nav.searchPrompt')}
            placeholder={t('nav.searchPrompt')}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
          />
          <IconButton label={t('shortcuts.close')} onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="workspace-search-filters" role="group" aria-label={t('nav.search')}>
          <div className="workspace-search-tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="workspace-search-tab"
                data-testid={`global-search-tab-${id}`}
                aria-selected={tab === id}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  onTab(id);
                }}
              >
                {t(label)}
              </button>
            ))}
          </div>
          {dated && (
            <>
              <span className="workspace-search-split" aria-hidden="true" />
              <div className="workspace-search-tabs">
                {dates.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className="workspace-search-tab"
                    aria-pressed={when === id}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      setWhen(when === id ? null : id);
                    }}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="workspace-search-line" />
        <div className="workspace-search-results" ref={results} data-testid="global-search-results">
          {showSessions && sessionRows.length > 0 && (
            <section>
              <h3>{t('sidebar.label')}</h3>
              {sessionRows.map((session) => {
                const { active, props } = row(
                  'search-title',
                  close(() => {
                    open({ session: session.id });
                  }),
                );
                return (
                  <button key={session.id} {...props} data-session-id={session.id}>
                    <span className="workspace-search-main">
                      <SideChatIcon />
                      <span className="truncate">{sessionTitle(session.title, untitled)}</span>
                    </span>
                    <span className="workspace-search-time">
                      {active ? (
                        <ReturnIcon />
                      ) : session.archived ? (
                        <span className="workspace-search-badge">{t('session.archived')}</span>
                      ) : (
                        whenLabel(session.updatedAt ?? session.createdAt, t)
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {showProjects && projectRows.length > 0 && (
            <section>
              <h3>{t('nav.projects')}</h3>
              {projectRows.map((project) => {
                const { active, props } = row(
                  'search-project',
                  close(() => {
                    open({ project: project.path });
                  }),
                );
                return (
                  <button key={project.path} {...props} data-tooltip={project.path}>
                    <span className="workspace-search-main">
                      <FolderIcon />
                      <span className="truncate">{project.displayName}</span>
                      <span className="workspace-search-meta truncate">{project.path}</span>
                    </span>
                    <span className="workspace-search-time">
                      {active ? <ReturnIcon /> : whenLabel(activity.get(project.path), t)}
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {showActions && actionRows.length > 0 && (
            <section>
              <h3>{t('palette.group.actions')}</h3>
              {actionRows.map((action) => {
                const { props } = row('search-action', runAction(action.id));
                return (
                  <button key={action.id} {...props} data-entry={`action:${action.id}`}>
                    <span className="workspace-search-main">
                      <CommandIcon />
                      <span className="truncate">{t(action.label)}</span>
                    </span>
                    <span className="workspace-search-time">
                      {bindings[action.id] ? (
                        <Keycaps binding={bindings[action.id]} platform={keyPlatform} />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {showActions && slashRows.length > 0 && (
            <section>
              <h3>{t('palette.group.commands')}</h3>
              {slashRows.map((entry) => {
                const { props } = row(
                  'search-slash',
                  close(() => {
                    command(entry.name);
                  }),
                );
                return (
                  <button key={entry.name} {...props} data-entry={`command:${entry.name}`}>
                    <span className="workspace-search-main">
                      <span className="workspace-search-slash">/{entry.name}</span>
                      <span className="workspace-search-meta truncate">{entry.description}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {showShortcuts && shortcutRows.length > 0 && (
            <section data-testid="shortcut-list">
              <h3>{t('nav.searchShortcuts')}</h3>
              {shortcutRows.map((entry) => {
                const { props } = row('search-shortcut', runAction(entry.id));
                return (
                  <button key={entry.id} {...props} data-command={entry.id}>
                    <span className="workspace-search-main">
                      <span className="truncate">{t(entry.label)}</span>
                    </span>
                    <span className="workspace-search-time">{keys(bindings[entry.id])}</span>
                  </button>
                );
              })}
            </section>
          )}
          {showShortcuts && builtinRows.length > 0 && (
            <section data-testid="help-commands">
              <h3>{t('nav.searchBuiltins')}</h3>
              {builtinRows.map((name) => {
                const label = builtin(name)?.label;
                const { props } = row(
                  'search-builtin',
                  close(() => {
                    command(name);
                  }),
                  current === undefined,
                );
                return (
                  <button key={name} {...props} data-command={name}>
                    <span className="workspace-search-main">
                      <span className="workspace-search-slash">/{name}</span>
                      <span className="workspace-search-meta truncate">
                        {label === undefined ? null : t(label)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {nothing && <p className="search-empty muted">{t('palette.none')}</p>}
          {(tab === 'all' || tab === 'session') && (
            <MessageSearch filter={query} onSelect={onClose} />
          )}
        </div>
        <footer className="workspace-search-footer">
          <span className="workspace-search-hint">
            {t('nav.searchSelect')}
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          <span className="workspace-search-hint">
            {t('nav.searchOpen')}
            <kbd>⏎</kbd>
          </span>
          <span className="workspace-search-hint">
            {t('nav.searchClose')}
            <kbd>{t('nav.searchCloseKey')}</kbd>
          </span>
          {showShortcuts && (
            <button
              type="button"
              className="workspace-search-link"
              data-testid="global-search-edit-shortcuts"
              onClick={close(() => {
                void window.piarc.openSettings('shortcuts');
              })}
            >
              <GearIcon />
              {t('nav.searchEditShortcuts')}
            </button>
          )}
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
