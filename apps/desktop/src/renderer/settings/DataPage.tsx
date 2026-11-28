// Data management (settings): the archived sessions (a sub-page with search, a project filter
// and the sessions grouped by project), archiving or deleting every session, and the data
// export. The sessions come from Core's snapshot in the store; every change goes through
// Core, and archiving or deleting is confirmed in the main process's native dialog.
// `#/settings/data` is the page, `#/settings/data?view=archived` the archived sessions.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import { ChevronRightIcon, FolderIcon, MoreIcon } from '../shell/icons.js';
import { ChoiceButton, MenuButton, type MenuItem } from '../shell/Menu.js';
import { sessionTitle } from '../shell/SessionRow.js';
import { baseName } from '../shell/ui.js';
import { useSessions, useWorkspaces } from '../store/hooks.js';
import type { SessionEntry } from '../store/snapshots.js';
import { CatalogEmpty, CatalogSearch, CatalogToolbar, Crumbs } from './catalog.js';
import { SettingsRow, SettingsSection } from './layout.js';
import { PageHeading } from './page-head.js';

type View = 'main' | 'archived';

function viewOf(hash: string): View {
  return new URLSearchParams(/\?(.*)$/u.exec(hash)?.[1] ?? '').get('view') === 'archived'
    ? 'archived'
    : 'main';
}

function hashOf(view: View): string {
  return view === 'archived' ? '#/settings/data?view=archived' : '#/settings/data';
}

/** A line under a row: what the last action did, or why it failed. */
type Note = { readonly tone: 'done' | 'error'; readonly text: string } | undefined;

export function DataPage() {
  const [view, setView] = useState<View>(() => viewOf(window.location.hash));
  const go = useCallback((next: View) => {
    setView(next);
    window.history.replaceState(null, '', hashOf(next));
    document.querySelector('.settings-page')?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    // A link to this page (`hashchange`) chooses the view; the page keeps the address current.
    const onHash = () => {
      if (/^#\/settings\/data(?:\?|$)/u.test(window.location.hash)) {
        setView(viewOf(window.location.hash));
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  return view === 'archived' ? (
    <ArchivedSessions
      onBack={() => {
        go('main');
      }}
    />
  ) : (
    <DataOverview
      onArchived={() => {
        go('archived');
      }}
    />
  );
}

/** "12.3 MB" in the app's language. */
function size(bytes: number, format: ReturnType<typeof useApp>['format']): string {
  const [unit, value] =
    bytes >= 1_000_000_000
      ? (['gigabyte', bytes / 1e9] as const)
      : bytes >= 1_000_000
        ? (['megabyte', bytes / 1e6] as const)
        : (['kilobyte', Math.max(bytes / 1e3, 0.1)] as const);
  return format.number(value, { style: 'unit', unit, maximumFractionDigits: 1 });
}

function DataOverview({ onArchived }: { readonly onArchived: () => void }) {
  const { t, format, platform } = useApp();
  const sessions = useSessions();
  const active = sessions.filter((s) => !s.archived);
  const archived = sessions.length - active.length;
  const [busy, setBusy] = useState<'archive' | 'delete' | 'export' | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [exportedPath, setExportedPath] = useState(false);
  const note = (row: string, value: Note) => {
    setNotes((current) => ({ ...current, [row]: value }));
  };
  const bulk = async (row: 'archive' | 'delete', ids: readonly string[]) => {
    if (ids.length === 0) return;
    setBusy(row);
    note(row, undefined);
    try {
      const result = await window.piarc.bulkSessions(row, ids);
      if (result === null) return;
      const done = t(row === 'archive' ? 'data.archiveAll.done' : 'data.deleteAll.done', {
        count: result.done,
      });
      note(
        row,
        result.failed === 0
          ? { tone: 'done', text: done }
          : {
              tone: 'error',
              text: `${done} · ${t('data.bulk.failed', { count: result.failed })}`,
            },
      );
    } catch (failure) {
      note(row, { tone: 'error', text: reason(failure) });
    } finally {
      setBusy(null);
    }
  };
  const exportData = async () => {
    setBusy('export');
    note('export', undefined);
    setExportedPath(false);
    try {
      const answer = await window.piarc.exportData();
      if (answer === null) return;
      const parsed: unknown = JSON.parse(answer);
      const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const count =
        'sessions' in record && typeof record.sessions === 'number' ? record.sessions : 0;
      const bytes = 'bytes' in record && typeof record.bytes === 'number' ? record.bytes : 0;
      note('export', {
        tone: 'done',
        text: t('data.export.done', { count, size: size(bytes, format) }),
      });
      setExportedPath(true);
    } catch (failure) {
      note('export', {
        tone: 'error',
        text: t('data.export.failed', { reason: reason(failure) }),
      });
    } finally {
      setBusy(null);
    }
  };
  const line = (row: string) => {
    const value = notes[row];
    return value === undefined ? undefined : (
      <span
        className={value.tone === 'error' ? 'data-note is-error' : 'data-note'}
        role={value.tone === 'error' ? 'alert' : 'status'}
        data-testid={`data-note-${row}`}
      >
        {value.text}
      </span>
    );
  };
  const windows = platform === 'win32';
  return (
    <>
      <SettingsSection title={t('data.section.history')} testId="data-history">
        <button
          type="button"
          className="settings-row data-link-row"
          data-testid="data-open-archived"
          onClick={onArchived}
        >
          <span className="settings-row-copy">
            <span className="settings-row-name">{t('data.archived')}</span>
            <span className="settings-row-description">{t('data.archived.hint')}</span>
          </span>
          <span className="settings-row-control data-link-trail">
            <span className="data-count">{t('data.archived.count', { count: archived })}</span>
            <ChevronRightIcon />
          </span>
        </button>
        <SettingsRow
          label={t('data.archiveAll')}
          description={line('archive') ?? t('data.archiveAll.hint')}
          testId="data-archive-all"
        >
          <Button
            size="small"
            loading={busy === 'archive'}
            disabled={active.length === 0 || (busy !== null && busy !== 'archive')}
            data-testid="data-archive-all-button"
            onClick={() => {
              void bulk(
                'archive',
                active.map((s) => s.id),
              );
            }}
          >
            {t('data.archiveAll.action')}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('data.deleteAll')}
          description={line('delete') ?? t('data.deleteAll.hint')}
          testId="data-delete-all"
        >
          <Button
            size="small"
            variant="destructive"
            loading={busy === 'delete'}
            disabled={sessions.length === 0 || (busy !== null && busy !== 'delete')}
            data-testid="data-delete-all-button"
            onClick={() => {
              void bulk(
                'delete',
                sessions.map((s) => s.id),
              );
            }}
          >
            {t('data.deleteAll.action')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('data.section.export')} testId="data-export">
        <SettingsRow
          label={t('data.export')}
          description={line('export') ?? t('data.export.hint')}
          testId="data-export-row"
        >
          {exportedPath && (
            <Button
              size="small"
              variant="ghost"
              data-testid="data-export-reveal"
              onClick={() => {
                void window.piarc.revealDataExport();
              }}
            >
              {t(windows ? 'skills.revealWin' : 'skills.revealMac')}
            </Button>
          )}
          <Button
            size="small"
            loading={busy === 'export'}
            disabled={sessions.length === 0 || (busy !== null && busy !== 'export')}
            data-testid="data-export-button"
            onClick={() => {
              void exportData();
            }}
          >
            {t('data.export.action')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

interface Group {
  readonly key: string;
  readonly name: string;
  readonly path: string | undefined;
  readonly sessions: SessionEntry[];
}

const NO_PROJECT = '';

function ArchivedSessions({ onBack }: { readonly onBack: () => void }) {
  const { t, format } = useApp();
  const sessions = useSessions();
  const workspaces = useWorkspaces();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | undefined>(undefined);
  const untitled = t('session.untitled');
  const names = useMemo(
    () => new Map(workspaces.map((w) => [w.path, w.displayName])),
    [workspaces],
  );
  const archived = useMemo(() => sessions.filter((s) => s.archived), [sessions]);
  const projectOf = (s: SessionEntry) => s.workspace ?? s.cwd ?? NO_PROJECT;
  const nameOf = (path: string) =>
    path === NO_PROJECT ? t('data.archived.noProject') : (names.get(path) ?? baseName(path));
  const projects = [...new Set(archived.map(projectOf))].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b)),
  );
  const needle = query.trim().toLowerCase();
  const groups: Group[] = [];
  for (const session of [...archived].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  )) {
    const path = projectOf(session);
    if (project !== null && path !== project) continue;
    if (needle && !sessionTitle(session.title, untitled).toLowerCase().includes(needle)) continue;
    let group = groups.find((g) => g.key === path);
    if (group === undefined) {
      group = {
        key: path,
        name: nameOf(path),
        path: path === NO_PROJECT ? undefined : path,
        sessions: [],
      };
      groups.push(group);
    }
    group.sessions.push(session);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  const run = async (ids: readonly string[], action: () => Promise<unknown>) => {
    setError(undefined);
    setBusy((current) => new Set([...current, ...ids]));
    try {
      await action();
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setBusy((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  };
  const restore = (session: SessionEntry) =>
    run([session.id], () => window.piarc.setSessionArchived(session.id, false));
  const remove = (session: SessionEntry) =>
    run([session.id], () =>
      window.piarc.deleteSession(session.id, sessionTitle(session.title, untitled)),
    );
  const bulk = (op: 'unarchive' | 'delete', group: Group) => {
    const ids = group.sessions.map((s) => s.id);
    return run(ids, () => window.piarc.bulkSessions(op, ids));
  };

  const filterItems: MenuItem[] = [
    {
      id: 'all',
      label: t('data.archived.allProjects'),
      selected: project === null,
      run: () => {
        setProject(null);
      },
    },
    ...projects.map((path) => ({
      id: `project:${path}`,
      label: nameOf(path),
      ...(path === NO_PROJECT ? {} : { hint: path }),
      selected: project === path,
      run: () => {
        setProject(path);
      },
    })),
  ];

  return (
    <>
      <PageHeading>
        <Crumbs
          items={[
            { label: t('settings.data'), onClick: onBack, testId: 'data-back' },
            { label: t('data.archived') },
          ]}
          title={t('data.archived')}
          description={t('data.archived.description')}
        />
      </PageHeading>
      <CatalogToolbar>
        <CatalogSearch
          value={query}
          label={t('data.archived.search')}
          testId="archived-search"
          onChange={setQuery}
        />
        <ChoiceButton
          label={t('data.archived.project')}
          valueLabel={project === null ? t('data.archived.allProjects') : nameOf(project)}
          className="data-filter"
          testId="archived-project-filter"
          above={false}
          items={filterItems}
          disabled={archived.length === 0}
        >
          <FolderIcon />
          <span className="truncate">
            {project === null ? t('data.archived.allProjects') : nameOf(project)}
          </span>
        </ChoiceButton>
      </CatalogToolbar>
      {error !== undefined && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {groups.length === 0 ? (
        <CatalogEmpty testId="archived-empty">
          {archived.length === 0 ? t('data.archived.empty') : t('data.archived.noMatch')}
        </CatalogEmpty>
      ) : (
        <div className="data-archived" aria-labelledby={titleId} data-testid="archived-list">
          <span id={titleId} className="visually-hidden">
            {t('data.archived')}
          </span>
          {groups.map((group) => (
            <section
              key={group.key}
              className="data-group"
              data-testid="archived-group"
              data-project={group.key}
            >
              <header className="data-group-head">
                <FolderIcon />
                <h3 className="truncate" data-tooltip={group.path}>
                  {group.name}
                </h3>
                <span className="data-count">
                  {t('data.archived.sessions', { count: group.sessions.length })}
                </span>
                <MenuButton
                  label={t('data.archived.actions', { name: group.name })}
                  testId="archived-group-menu"
                  items={[
                    {
                      id: 'restore-all',
                      label: t('data.archived.restoreAll'),
                      testId: 'archived-restore-all',
                      run: () => {
                        void bulk('unarchive', group);
                      },
                    },
                    {
                      id: 'delete-all',
                      label: t('data.archived.deleteAll'),
                      testId: 'archived-delete-all',
                      danger: true,
                      run: () => {
                        void bulk('delete', group);
                      },
                    },
                  ]}
                >
                  <MoreIcon />
                </MenuButton>
              </header>
              <ul className="data-sessions">
                {group.sessions.map((session) => {
                  const at = session.updatedAt ?? session.createdAt;
                  const working = busy.has(session.id);
                  return (
                    <li
                      key={session.id}
                      className="data-session"
                      data-testid="archived-session"
                      data-session-id={session.id}
                    >
                      <div className="data-session-copy">
                        <span className="data-session-title truncate">
                          {sessionTitle(session.title, untitled)}
                        </span>
                        {at !== undefined && (
                          <span className="data-session-when">{format.dateTime(at)}</span>
                        )}
                      </div>
                      <div className="data-session-actions">
                        <Button
                          size="small"
                          disabled={working}
                          data-testid="archived-restore"
                          onClick={() => {
                            void restore(session);
                          }}
                        >
                          {t('data.archived.restore')}
                        </Button>
                        <Button
                          size="small"
                          variant="destructive"
                          disabled={working}
                          data-testid="archived-delete"
                          onClick={() => {
                            void remove(session);
                          }}
                        >
                          {t('data.archived.delete')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
