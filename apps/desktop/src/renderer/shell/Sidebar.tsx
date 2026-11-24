// Navigation follows the user's project order. Session status and all mutations come from Core.
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { displayKey, effectiveBindings } from '../../shared/keybindings.js';
import { IconButton } from '../app/IconButton.js';
import { useApp } from '../app/app-context.js';
import { useSessions, useStore, useWorkspaces } from '../store/hooks.js';
import type { SessionEntry, WorkspaceEntry } from '../store/snapshots.js';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GearIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
} from './icons.js';
import { ChoiceButton, MenuPopup, useMenu } from './Menu.js';
import { ProjectGroup, type ProjectSessions } from './ProjectGroup.js';
import { WorkspaceSearch } from './WorkspaceSearch.js';
import { sessionTitle } from './SessionRow.js';
import { loadSidebarGroups, saveSidebarGroups, type SidebarGroups } from './layout.js';
import { baseName, useUi } from './ui.js';

function order(a: SessionEntry, b: SessionEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const at = (s: SessionEntry) => s.updatedAt ?? s.createdAt ?? Number.MAX_SAFE_INTEGER;
  return at(b) - at(a);
}

/** Recent projects first unless the user has arranged them; pinned sessions lead each group. */
export function groupSessions(
  workspaces: readonly WorkspaceEntry[],
  sessions: readonly SessionEntry[],
  filter: string,
  showArchived: boolean,
  untitled: string,
  projectOrder: readonly string[] = [],
): ProjectSessions[] {
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
    if (session.archived && !showArchived) continue;
    const path = session.workspace ?? session.cwd ?? '';
    let group = groups.get(path);
    if (group === undefined) {
      group = { name: baseName(path), sessions: [], at: 0 };
      groups.set(path, group);
    }
    if (
      !query ||
      sessionTitle(session.title, untitled).toLowerCase().includes(query) ||
      group.name.toLowerCase().includes(query)
    ) {
      group.sessions.push(session);
    }
  }
  const positions = new Map(projectOrder.map((path, index) => [path, index]));
  return [...groups.entries()]
    .filter(([, group]) => !query || group.sessions.length > 0)
    .sort(
      ([a, left], [b, right]) =>
        (positions.get(a) ?? projectOrder.length) - (positions.get(b) ?? projectOrder.length) ||
        right.at - left.at,
    )
    .map(([path, group]) => ({ path, name: group.name, sessions: group.sessions.sort(order) }));
}

interface History {
  readonly back: (() => void) | undefined;
  readonly forward: (() => void) | undefined;
}

export function Sidebar({
  resizer,
  history,
}: {
  readonly resizer?: ReactNode;
  readonly history?: History;
}) {
  const { t, preferences, keyPlatform } = useApp();
  const ui = useUi();
  const store = useStore();
  const workspaces = useWorkspaces();
  const sessions = useSessions();
  const [searching, setSearching] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [groupLayout, setGroupLayout] = useState(loadSidebarGroups);
  const [dragging, setDragging] = useState<string | null>(null);
  const more = useMenu();
  const groups = useMemo(
    () =>
      groupSessions(
        workspaces,
        sessions,
        '',
        showArchived,
        t('session.untitled'),
        groupLayout.order,
      ),
    [workspaces, sessions, showArchived, t, groupLayout.order],
  );
  const update = (next: SidebarGroups) => {
    setGroupLayout(next);
    saveSidebarGroups(next);
  };
  const move = (from: string, to: string | undefined) => {
    if (from === to || to === undefined) return;
    const paths = groups.map((group) => group.path);
    const fromIndex = paths.indexOf(from);
    const toIndex = paths.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    paths.splice(fromIndex, 1);
    paths.splice(toIndex, 0, from);
    update({ ...groupLayout, order: paths });
  };
  const draggedIndex = groups.findIndex((group) => group.path === dragging);
  const loaded = store.hasSessions();
  useEffect(() => {
    if (loaded && performance.getEntriesByName('piarc:sidebar-ready').length === 0) {
      performance.mark('piarc:sidebar-ready', { detail: { sessions: sessions.length } });
    }
  }, [loaded, sessions.length]);
  const newKey = displayKey(effectiveBindings(preferences.keybindings)['session.new'], keyPlatform);
  const activeSession = ui.view.kind === 'session' ? store.session(ui.view.id) : undefined;
  const provider = activeSession?.model?.split('/');
  const identity = provider && provider.length > 1 ? (provider[0] ?? t('app.name')) : t('app.name');
  return (
    <nav
      className="sidebar workbench-navigation"
      aria-label={t('sidebar.label')}
      data-testid="shell-sidebar"
    >
      <div className="titlebar sidebar-titlebar">
        <div className="titlebar-actions">
          <IconButton
            label={t('sidebar.collapse')}
            data-testid="collapse-sidebar"
            onClick={ui.toggleSidebar}
          >
            <SidebarIcon />
          </IconButton>
          <IconButton label={t('nav.back')} disabled={!history?.back} onClick={history?.back}>
            <ChevronLeftIcon />
          </IconButton>
          <IconButton
            label={t('nav.forward')}
            disabled={!history?.forward}
            onClick={history?.forward}
          >
            <ChevronRightIcon />
          </IconButton>
        </div>
      </div>
      <div className="sidebar-entries">
        <button
          className="nav-entry"
          type="button"
          data-testid="new-session"
          aria-current={ui.view.kind === 'home' ? 'page' : undefined}
          title={newKey ? `${t('sidebar.newSession')} (${newKey})` : t('sidebar.newSession')}
          onClick={() => {
            ui.runCommand('session.new');
          }}
        >
          <PlusIcon />
          {t('sidebar.newSession')}
        </button>
        <button
          className="nav-entry"
          type="button"
          data-testid="open-search"
          aria-haspopup="dialog"
          aria-expanded={searching}
          onClick={() => {
            setSearching(true);
          }}
        >
          <SearchIcon />
          {t('nav.search')}
        </button>
        <button
          className="nav-entry"
          type="button"
          data-testid="open-folder"
          onClick={() => {
            void ui.openFolder();
          }}
        >
          <FolderIcon />
          {t('sidebar.openFolder')}
        </button>
        <button
          className="nav-entry"
          type="button"
          data-testid="sidebar-more"
          aria-haspopup="menu"
          aria-expanded={more.open !== null}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            more.openAt(box.left, box.bottom);
          }}
        >
          <MoreIcon />
          {t('nav.more')}
        </button>
        {more.open && (
          <MenuPopup
            at={more.open}
            onClose={more.close}
            label={t('nav.more')}
            items={[
              {
                id: 'archived',
                label: t(showArchived ? 'nav.hideArchived' : 'nav.showArchived'),
                run: () => {
                  setShowArchived(!showArchived);
                },
              },
              {
                id: 'commands',
                label: t('palette.title'),
                run: () => {
                  ui.runCommand('app.commandPalette');
                },
              },
              { id: 'shortcuts', label: t('shortcuts.title'), run: ui.openShortcuts },
            ]}
          />
        )}
      </div>
      <div className="sidebar-list" data-testid="session-list">
        {loaded && groups.length === 0 && (
          <p className="sidebar-empty muted">{t('sidebar.empty')}</p>
        )}
        {groups.map((group, index) => {
          const closed = groupLayout.collapsed.includes(group.path);
          return (
            <ProjectGroup
              key={group.path}
              group={group}
              closed={closed}
              onToggle={() => {
                update({
                  ...groupLayout,
                  collapsed: closed
                    ? groupLayout.collapsed.filter((path) => path !== group.path)
                    : [...groupLayout.collapsed, group.path],
                });
              }}
              first={index === 0}
              last={index === groups.length - 1}
              onMove={(step) => {
                move(group.path, groups[index + step]?.path);
              }}
              dragging={
                draggedIndex < 0
                  ? null
                  : draggedIndex === index
                    ? 'source'
                    : draggedIndex < index
                      ? 'after'
                      : 'before'
              }
              dragStart={() => {
                setDragging(group.path);
              }}
              dragEnd={() => {
                setDragging(null);
              }}
              drop={() => {
                if (dragging !== null) move(dragging, group.path);
                setDragging(null);
              }}
            />
          );
        })}
      </div>
      <footer className="sidebar-footer">
        <ChoiceButton
          className="sidebar-identity"
          label={identity + ' · ' + t('settings.providers')}
          items={[
            {
              id: 'providers',
              label: t('settings.providers'),
              run: () => {
                void window.piarc.openSettings('providers');
              },
            },
            {
              id: 'usage',
              label: t('settings.usage'),
              run: () => {
                void window.piarc.openSettings('usage');
              },
            },
          ]}
        >
          <span className="piarc-mark" aria-hidden="true" />
          <span className="truncate">{identity}</span>
          <ChevronDownIcon />
        </ChoiceButton>
        <IconButton
          label={t('settings.title')}
          data-testid="open-settings"
          onClick={() => {
            void window.piarc.openSettings();
          }}
        >
          <GearIcon />
        </IconButton>
      </footer>
      {resizer}
      {searching && (
        <WorkspaceSearch
          showArchived={showArchived}
          onClose={() => {
            setSearching(false);
          }}
        />
      )}
    </nav>
  );
}
