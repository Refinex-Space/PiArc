// Search project names, session titles and indexed messages in one keyboard-accessible dialog.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSessions, useWorkspaces } from '../store/hooks.js';
import { Dialog } from './Dialog.js';
import { CloseIcon, FolderIcon, ReturnIcon, SearchIcon, SideChatIcon } from './icons.js';
import { MessageSearch } from './MessageSearch.js';
import { sessionTitle } from './SessionRow.js';
import { baseName, useUi } from './ui.js';

type Kind = 'all' | 'session' | 'project';
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

function whenLabel(ms: number | undefined, t: ReturnType<typeof useT>): string | null {
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

export function WorkspaceSearch({
  showArchived,
  onClose,
}: {
  showArchived: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const ui = useUi();
  const sessions = useSessions();
  const workspaces = useWorkspaces();
  const title = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [when, setWhen] = useState<When | null>(null);
  const [selected, setSelected] = useState(0);
  const needle = query.trim().toLowerCase();
  const floor = dateFloor(when);
  const activity = new Map<string, number>();
  for (const session of sessions) {
    const path = session.workspace ?? session.cwd ?? '';
    const at = session.updatedAt ?? session.createdAt ?? 0;
    activity.set(path, Math.max(activity.get(path) ?? 0, at));
  }
  const projectNames = new Map(workspaces.map((w) => [w.path, w.displayName]));
  const untitled = t('session.untitled');
  const fresh = (at: number | undefined) => floor === null || (at ?? 0) >= floor;
  const matched = sessions
    .filter((session) => showArchived || !session.archived)
    .filter((session) => fresh(session.updatedAt ?? session.createdAt))
    .filter((session) => {
      const path = session.workspace ?? session.cwd ?? '';
      return (
        !needle ||
        sessionTitle(session.title, untitled).toLowerCase().includes(needle) ||
        (projectNames.get(path) ?? baseName(path)).toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, kind === 'session' ? 50 : 8);
  const projects = workspaces
    .filter((project) => fresh(activity.get(project.path)))
    .filter(
      (project) =>
        !needle ||
        project.displayName.toLowerCase().includes(needle) ||
        project.path.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        (activity.get(b.path) ?? 0) - (activity.get(a.path) ?? 0) ||
        a.displayName.localeCompare(b.displayName),
    )
    .slice(0, kind === 'project' ? 50 : 5);
  const showSessions = kind !== 'project';
  const showProjects = kind !== 'session';
  const optionCount = (showSessions ? matched.length : 0) + (showProjects ? projects.length : 0);
  useEffect(() => {
    setSelected(0);
  }, [needle, kind, when]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    const options = Array.from(
      results.current?.querySelectorAll<HTMLButtonElement>('.search-destination') ?? [],
    );
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return;
      event.preventDefault();
      setSelected((at) =>
        event.key === 'ArrowDown'
          ? (at + 1) % options.length
          : (at - 1 + options.length) % options.length,
      );
      return;
    }
    if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      options[selected]?.click();
    }
  };
  const kinds = [
    ['all', 'nav.searchAll'],
    ['session', 'sidebar.label'],
    ['project', 'nav.projects'],
  ] as const;
  const dates = [
    ['today', 'nav.filterToday'],
    ['week', 'nav.filterWeek'],
    ['month', 'nav.filterMonth'],
  ] as const;
  let option = 0;

  return createPortal(
    <Dialog labelledBy={title} onCancel={onClose} testId="workspace-search" wide dismissOnBackdrop>
      <div className="workspace-search-content" onKeyDown={navigate}>
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
            data-testid="session-filter"
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
            {kinds.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="workspace-search-tab"
                aria-selected={kind === id}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  setKind(id);
                }}
              >
                {t(label)}
              </button>
            ))}
          </div>
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
        </div>
        <div className="workspace-search-line" />
        <div className="workspace-search-results" ref={results}>
          {showSessions && matched.length > 0 && (
            <section>
              <h3>{t('sidebar.label')}</h3>
              {matched.map((session) => {
                const index = option++;
                const active = index === selected;
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`search-destination${active ? ' is-selected' : ''}`}
                    data-testid="search-title"
                    data-session-id={session.id}
                    onMouseMove={() => {
                      setSelected(index);
                    }}
                    onClick={() => {
                      onClose();
                      ui.show({ kind: 'session', id: session.id });
                    }}
                  >
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
          {showProjects && projects.length > 0 && (
            <section>
              <h3>{t('nav.projects')}</h3>
              {projects.map((project) => {
                const index = option++;
                const active = index === selected;
                return (
                  <button
                    key={project.path}
                    type="button"
                    className={`search-destination${active ? ' is-selected' : ''}`}
                    data-testid="search-project"
                    title={project.path}
                    onMouseMove={() => {
                      setSelected(index);
                    }}
                    onClick={() => {
                      onClose();
                      ui.show({ kind: 'home', workspace: project.path });
                    }}
                  >
                    <span className="workspace-search-main">
                      <FolderIcon />
                      <span className="truncate">{project.displayName}</span>
                      <span className="workspace-search-meta truncate">{project.path}</span>
                    </span>
                    <span className="workspace-search-time">
                      {active ? (
                        <ReturnIcon />
                      ) : (
                        whenLabel(activity.get(project.path), t)
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          {optionCount === 0 && <p className="search-empty muted">{t('palette.none')}</p>}
          {kind !== 'project' && <MessageSearch filter={query} onSelect={onClose} />}
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
            <kbd>esc</kbd>
          </span>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
