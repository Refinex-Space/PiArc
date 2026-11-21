// The sidebar (architecture section 8.2): sessions grouped by workspace, each with its status
// badge; filter, pinned sessions first, archived ones on request; new session and open folder.
import { useEffect, useMemo, useState } from 'react';

import { displayKey, effectiveBindings } from '../../shared/keybindings.js';
import { useApp } from '../app/app-context.js';
import { useSessions, useStore, useWorkspaces } from '../store/hooks.js';
import type { SessionEntry, WorkspaceEntry } from '../store/snapshots.js';
import { FolderIcon, GearIcon, PlusIcon, SidebarIcon } from './icons.js';
import { MenuButton } from './Menu.js';
import { MessageSearch } from './MessageSearch.js';
import { SessionRow, sessionTitle } from './SessionRow.js';
import { baseName, useUi } from './ui.js';

interface Group {
  readonly path: string;
  readonly name: string;
  readonly sessions: readonly SessionEntry[];
}

/** Newest first; pinned sessions before the others. */
function order(a: SessionEntry, b: SessionEntry): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  const at = (s: SessionEntry) => s.updatedAt ?? s.createdAt ?? Number.MAX_SAFE_INTEGER;
  return at(b) - at(a);
}

/** Sessions grouped by workspace, recently opened workspaces first. */
export function groupSessions(
  workspaces: readonly WorkspaceEntry[],
  sessions: readonly SessionEntry[],
  filter: string,
  showArchived: boolean,
  untitled: string,
): Group[] {
  const query = filter.trim().toLowerCase();
  const groups = new Map<string, { name: string; sessions: SessionEntry[]; at: number }>();
  for (const workspace of workspaces) {
    groups.set(workspace.path, {
      name: workspace.displayName,
      sessions: [],
      at: workspace.lastOpenedAt,
    });
  }
  for (const session of sessions) {
    if (session.archived && !showArchived) {
      continue;
    }
    const path = session.workspace ?? session.cwd ?? '';
    const title = sessionTitle(session.title, untitled).toLowerCase();
    let group = groups.get(path);
    if (group === undefined) {
      group = { name: baseName(path), sessions: [], at: 0 };
      groups.set(path, group);
    }
    if (query.length === 0 || title.includes(query) || group.name.toLowerCase().includes(query)) {
      group.sessions.push(session);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => query.length === 0 || group.sessions.length > 0)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([path, group]) => ({ path, name: group.name, sessions: group.sessions.sort(order) }));
}

export function Sidebar() {
  const { t, preferences, keyPlatform } = useApp();
  const ui = useUi();
  const store = useStore();
  const workspaces = useWorkspaces();
  const sessions = useSessions();
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const groups = useMemo(
    () => groupSessions(workspaces, sessions, filter, showArchived, t('session.untitled')),
    [workspaces, sessions, filter, showArchived, t],
  );
  // Cold-start measurement (architecture chapter 11): the first time Core's session list is on
  // screen.
  const loaded = store.hasSessions();
  useEffect(() => {
    if (loaded && performance.getEntriesByName('piarc:sidebar-ready').length === 0) {
      performance.mark('piarc:sidebar-ready', { detail: { sessions: sessions.length } });
    }
  }, [loaded, sessions.length]);
  const newKey = displayKey(effectiveBindings(preferences.keybindings)['session.new'], keyPlatform);
  return (
    <nav className="sidebar" aria-label={t('sidebar.label')} data-testid="shell-sidebar">
      <div className="titlebar sidebar-titlebar">
        <div className="titlebar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.collapse')}
            title={t('sidebar.collapse')}
            onClick={ui.toggleSidebar}
          >
            <SidebarIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.newSession')}
            title={
              newKey.length > 0 ? `${t('sidebar.newSession')} (${newKey})` : t('sidebar.newSession')
            }
            data-testid="new-session"
            onClick={() => {
              ui.show({
                kind: 'home',
                workspace: ui.view.kind === 'home' ? ui.view.workspace : undefined,
              });
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div className="sidebar-filter">
        <input
          type="search"
          className="input"
          placeholder={t('sidebar.filter')}
          aria-label={t('sidebar.filter')}
          value={filter}
          data-testid="session-filter"
          onChange={(event) => {
            setFilter(event.currentTarget.value);
          }}
        />
      </div>
      <div className="sidebar-list" data-testid="session-list">
        {loaded && groups.length === 0 && filter.trim().length === 0 && (
          <p className="sidebar-empty muted">
            {filter.trim().length > 0
              ? t('sidebar.noMatches', { query: filter.trim() })
              : t('sidebar.empty')}
          </p>
        )}
        {groups.map((group) => (
          <section
            key={group.path}
            className="workspace-group"
            data-testid="workspace-group"
            data-path={group.path}
          >
            <header className="workspace-header">
              <span className="workspace-name truncate" title={group.path}>
                {group.name}
              </span>
              <MenuButton
                label={t('workspace.actions', { name: group.name })}
                testId="workspace-actions"
                items={[
                  {
                    id: 'new-session',
                    label: t('workspace.newSession', { name: group.name }),
                    run: () => {
                      ui.show({ kind: 'home', workspace: group.path });
                    },
                  },
                  {
                    id: 'trust',
                    label: t('workspace.trust'),
                    run: () => {
                      void ui.ensureTrust(group.path, 'review');
                    },
                  },
                ]}
              >
                ⋯
              </MenuButton>
            </header>
            {group.sessions.length === 0 ? (
              <p className="workspace-empty muted small">{t('sidebar.workspaceEmpty')}</p>
            ) : (
              <ul className="session-list">
                {group.sessions.map((session) => (
                  <SessionRow key={session.id} id={session.id} />
                ))}
              </ul>
            )}
          </section>
        ))}
        <MessageSearch filter={filter} />
      </div>
      <footer className="sidebar-footer">
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={showArchived}
            data-testid="show-archived"
            onChange={(event) => {
              setShowArchived(event.currentTarget.checked);
            }}
          />
          {t('sidebar.showArchived')}
        </label>
        <div className="footer-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.openFolder')}
            title={t('sidebar.openFolder')}
            data-testid="open-folder"
            onClick={() => {
              void ui.openFolder();
            }}
          >
            <FolderIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('settings.title')}
            title={t('settings.title')}
            data-testid="open-settings"
            onClick={() => {
              void window.piarc.openSettings();
            }}
          >
            <GearIcon />
          </button>
        </div>
      </footer>
    </nav>
  );
}
