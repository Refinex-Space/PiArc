// Search project names, session titles and indexed messages in one keyboard-accessible dialog.
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSessions, useWorkspaces } from '../store/hooks.js';
import { Dialog } from './Dialog.js';
import { CloseIcon, FolderIcon, SearchIcon, SideChatIcon } from './icons.js';
import { MessageSearch } from './MessageSearch.js';
import { sessionTitle } from './SessionRow.js';
import { baseName, useUi } from './ui.js';

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
  const needle = query.trim().toLowerCase();
  const projects = workspaces.filter(
    (w) => w.displayName.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle),
  );
  const projectNames = new Map(workspaces.map((w) => [w.path, w.displayName]));
  const untitled = t('session.untitled');
  const matched = sessions
    .filter((session) => {
      if (session.archived && !showArchived) return false;
      const path = session.workspace ?? session.cwd ?? '';
      return (
        sessionTitle(session.title, untitled).toLowerCase().includes(needle) ||
        (projectNames.get(path) ?? baseName(path)).toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  const visibleSessions = needle.length ? matched : matched.slice(0, 8);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    const options = Array.from(
      results.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    if (!options.length) return;
    if (event.target === input.current && event.key === 'Enter') {
      event.preventDefault();
      options[0]?.click();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = options.findIndex((el) => el === event.target);
    if (event.key === 'ArrowUp' && at === 0) {
      input.current?.focus();
      return;
    }
    const to =
      event.key === 'ArrowDown' ? (at + 1) % options.length : at < 0 ? options.length - 1 : at - 1;
    options[to]?.focus();
  };

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
        <div className="workspace-search-results" ref={results}>
          {visibleSessions.length > 0 && (
            <section>
              <h3>{t(needle ? 'sidebar.label' : 'nav.recent')}</h3>
              {visibleSessions.map((session) => {
                const path = session.workspace ?? session.cwd ?? '';
                return (
                  <button
                    key={session.id}
                    type="button"
                    className="search-destination"
                    data-testid="search-title"
                    data-session-id={session.id}
                    onClick={() => {
                      onClose();
                      ui.show({ kind: 'session', id: session.id });
                    }}
                  >
                    <SideChatIcon />
                    <span className="truncate">{sessionTitle(session.title, untitled)}</span>
                    <small className="truncate">{projectNames.get(path) ?? baseName(path)}</small>
                  </button>
                );
              })}
            </section>
          )}
          {projects.length > 0 && (
            <section>
              <h3>{t('nav.projects')}</h3>
              {projects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  className="search-destination"
                  data-testid="search-project"
                  title={project.path}
                  onClick={() => {
                    onClose();
                    ui.show({ kind: 'home', workspace: project.path });
                  }}
                >
                  <FolderIcon />
                  <span className="truncate">{project.displayName}</span>
                </button>
              ))}
            </section>
          )}
          {!needle && !projects.length && !matched.length && (
            <p className="search-empty muted">{t('sidebar.empty')}</p>
          )}
          <MessageSearch filter={query} onSelect={onClose} />
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
