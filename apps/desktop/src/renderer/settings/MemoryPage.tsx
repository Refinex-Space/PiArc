// The memory page (T47, design addendum section 4.2): auto memory's switches (the user's, this
// project's; read-only when the organization manages them), the notes of the chosen workspace's
// repository (view, edit, delete), deleting them all and importing Claude Code's memory once.
// Core does every change (`memoryEdit`) and answers the page anew; it audits each edit.
import { PageHeadActions } from './page-head.js';
import { ScopePicker } from './ScopePicker.js';
import { SettingsRow, SettingsSection } from './layout.js';
import { SettingsInfo } from './layout.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { WorkspaceOptions } from './WorkspaceOptions.js';

import { useApp } from '../app/app-context.js';
import { parseWorkspaces } from './AgentsPage.js';
import { ManagedBadge, useManaged } from './managed.js';
import { clearMemoryTarget, peekMemoryTarget } from './memory-target.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';

const TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof TYPES)[number];

export interface MemoryNote {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly modified: string;
  readonly session: string;
  readonly body: string;
}

export interface MemoryView {
  readonly enabled: boolean;
  readonly userEnabled: boolean;
  readonly projectEnabled: boolean;
  readonly locked: boolean;
  readonly trusted: boolean;
  readonly directory: string;
  readonly memories: readonly MemoryNote[];
  readonly claude: { readonly path: string; readonly count: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's `memoryView` answer, validated. */
export function parseMemoryView(raw: string): MemoryView {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || typeof value.directory !== 'string') {
    throw new Error('Invalid memory view');
  }
  const memories = Array.isArray(value.memories)
    ? value.memories.flatMap((m): MemoryNote[] => {
        if (!isRecord(m) || typeof m.name !== 'string' || typeof m.description !== 'string') {
          return [];
        }
        const type = TYPES.find((x) => x === m.type);
        if (type === undefined) return [];
        return [
          {
            name: m.name,
            description: m.description,
            type,
            modified: typeof m.modified === 'string' ? m.modified : '',
            session: typeof m.session === 'string' ? m.session : '',
            body: typeof m.body === 'string' ? m.body : '',
          },
        ];
      })
    : [];
  const claude =
    isRecord(value.claude) &&
    typeof value.claude.path === 'string' &&
    typeof value.claude.count === 'number'
      ? { path: value.claude.path, count: value.claude.count }
      : null;
  return {
    enabled: value.enabled === true,
    userEnabled: value.userEnabled === true,
    projectEnabled: value.projectEnabled === true,
    locked: value.locked === true,
    trusted: value.trusted === true,
    directory: value.directory,
    memories,
    claude,
  };
}

/** Who wrote a note, for the list. */
function writer(session: string): 'user' | 'import' | 'session' {
  if (session === 'user') return 'user';
  if (session === 'import') return 'import';
  return 'session';
}

function NoteEditor({
  note,
  busy,
  onSave,
  onCancel,
}: {
  readonly note: MemoryNote;
  readonly busy: boolean;
  readonly onSave: (note: MemoryNote) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useApp();
  const [description, setDescription] = useState(note.description);
  const [type, setType] = useState<MemoryType>(note.type);
  const [body, setBody] = useState(note.body);
  const descriptionId = useId();
  const typeId = useId();
  const bodyId = useId();
  return (
    <form
      className="memory-editor"
      data-testid={`memory-editor-${note.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...note, description, type, body });
      }}
    >
      <label htmlFor={descriptionId} className="setting-label">
        {t('memory.description')}
      </label>
      <input
        id={descriptionId}
        className="input"
        value={description}
        maxLength={200}
        data-testid="memory-edit-description"
        onChange={(e) => {
          setDescription(e.currentTarget.value);
        }}
      />
      <label htmlFor={typeId} className="setting-label">
        {t('memory.type')}
      </label>
      <select
        id={typeId}
        className="input"
        value={type}
        data-testid="memory-edit-type"
        onChange={(e) => {
          const chosen = TYPES.find((x) => x === e.currentTarget.value);
          if (chosen !== undefined) setType(chosen);
        }}
      >
        {TYPES.map((x) => (
          <option key={x} value={x}>
            {t(`memory.type.${x}`)}
          </option>
        ))}
      </select>
      <label htmlFor={bodyId} className="setting-label">
        {t('memory.body')}
      </label>
      <textarea
        id={bodyId}
        className="input memory-body-input"
        rows={6}
        value={body}
        data-testid="memory-edit-body"
        onChange={(e) => {
          setBody(e.currentTarget.value);
        }}
      />
      <div className="memory-actions">
        <Button type="submit" variant="primary" disabled={busy} data-testid="memory-edit-save">
          {t('memory.save')}
        </Button>
        <Button variant="ghost" size="small" onClick={onCancel}>
          {t('memory.cancel')}
        </Button>
      </div>
    </form>
  );
}

function NoteRow({
  note,
  busy,
  opened,
  onEdit,
  onDelete,
}: {
  readonly note: MemoryNote;
  readonly busy: boolean;
  /** Opened from the transcript ("Open in settings"): shown expanded and scrolled to. */
  readonly opened: boolean;
  readonly onEdit: (note: MemoryNote) => void;
  readonly onDelete: (name: string) => void;
}) {
  const { t, format } = useApp();
  const [open, setOpen] = useState(opened);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (opened) row.current?.scrollIntoView({ block: 'nearest' });
  }, [opened]);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const at = Date.parse(note.modified);
  const when = Number.isNaN(at) ? note.modified : format.dateTime(at);
  return (
    <li ref={row} className="memory-note" data-testid={`memory-note-${note.name}`}>
      <div className="memory-note-head">
        <button
          type="button"
          className="memory-disclosure"
          aria-expanded={open}
          data-testid={`memory-open-${note.name}`}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="memory-note-name">{note.name}</span>
        </button>
        <span className="memory-type">{t(`memory.type.${note.type}`)}</span>
        <span className="muted small">
          {t(`memory.by.${writer(note.session)}`, { date: when })}
        </span>
      </div>
      <p className="memory-note-description">{note.description}</p>
      {open && !editing && <pre className="memory-note-body">{note.body}</pre>}
      {open && editing && (
        <NoteEditor
          note={note}
          busy={busy}
          onCancel={() => {
            setEditing(false);
          }}
          onSave={(edited) => {
            setEditing(false);
            onEdit(edited);
          }}
        />
      )}
      {open && !editing && (
        <div className="memory-actions">
          <Button
            size="small"
            disabled={busy}
            data-testid={`memory-edit-${note.name}`}
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('memory.edit')}
          </Button>
          <Button
            variant="destructive"
            size="small"
            disabled={busy}
            data-testid={`memory-delete-${note.name}`}
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                onDelete(note.name);
              } else {
                setConfirming(true);
              }
            }}
          >
            {t(confirming ? 'memory.deleteConfirm' : 'memory.delete')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function MemoryPage() {
  const { t } = useApp();
  const { view: managed, reload: reloadManaged } = useManaged();
  const selectId = useId();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<MemoryView | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');
  // `/memory` or a transcript row named the workspace (and note) to show.
  const [target] = useState(peekMemoryTarget);
  useEffect(clearMemoryTarget, []);
  const filterId = useId();
  const userId = useId();
  const projectId = useId();
  const fail = useCallback((e: unknown) => {
    setError(reason(e));
  }, []);
  useEffect(() => {
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        const known = parseWorkspaces(raw);
        const named = target?.workspace;
        setWorkspaces(
          named === undefined || known.workspaces.includes(named)
            ? known.workspaces
            : [named, ...known.workspaces],
        );
        setChosen((current) => current ?? named ?? known.workspace);
      })
      .catch(fail);
  }, [fail, target]);
  useEffect(() => {
    if (chosen === null) return;
    window.piarc
      .memoryView(chosen)
      .then((raw) => {
        setError('');
        setView(parseMemoryView(raw));
      })
      .catch(fail);
  }, [chosen, fail]);
  const edit = (change: Record<string, unknown>) => {
    if (chosen === null) return;
    setBusy(true);
    window.piarc
      .memoryEdit(chosen, JSON.stringify(change))
      .then((raw) => {
        setError('');
        setView(parseMemoryView(raw));
      })
      .catch((e: unknown) => {
        fail(e);
        reloadManaged();
      })
      .finally(() => {
        setBusy(false);
      });
  };
  // The organization may manage the switch even before the page knows (Core refuses then).
  const locked = view?.locked === true || managed.locked.includes('/autoMemoryEnabled');
  return (
    <div className="settings-section settings-detail-page" data-testid="memory-page">
      <PageHeadActions>
        <SettingsInfo text={t('memory.hint')} />
      </PageHeadActions>
      {chosen === null ? (
        <p className="muted">{t('agents.noWorkspace')}</p>
      ) : (
        <PageHeadActions>
          <ScopePicker>
            <select
              id={selectId}
              aria-label={t('permissions.workspace')}
              className="settings-scope-select"
              value={chosen}
              data-testid="memory-workspace"
              onChange={(e) => {
                setChosen(e.currentTarget.value);
              }}
            >
              <WorkspaceOptions workspaces={workspaces} />
            </select>
          </ScopePicker>
        </PageHeadActions>
      )}
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {view === undefined ? null : (
        <>
          <SettingsSection
            testId="memory-switches"
            title={
              <>
                {t('memory.switches')}
                {locked && <ManagedBadge testId="memory-managed" />}
              </>
            }
            aside={
              view.memories.length > 0 ? (
                <Button
                  size="small"
                  variant="ghost"
                  data-testid="memory-reveal"
                  onClick={() => {
                    if (chosen !== null) window.piarc.revealMemory(chosen).catch(fail);
                  }}
                >
                  {t('memory.reveal')}
                </Button>
              ) : undefined
            }
          >
            <SettingsRow
              label={t('memory.userEnabled')}
              htmlFor={userId}
              description={
                <span className="approval-path" title={view.directory}>
                  {t('memory.directory', { path: view.directory })}
                </span>
              }
            >
              <input
                id={userId}
                type="checkbox"
                className="preference-switch"
                // Locked: both show what the organization decided.
                checked={locked ? view.enabled : view.userEnabled}
                disabled={locked || busy}
                data-testid="memory-user-enabled"
                onChange={(e) => {
                  edit({ op: 'setEnabled', scope: 'user', enabled: e.currentTarget.checked });
                }}
              />
            </SettingsRow>
            <SettingsRow
              label={t('memory.projectEnabled')}
              htmlFor={projectId}
              description={
                <span data-testid="memory-state">
                  {t(
                    !view.enabled
                      ? 'memory.state.off'
                      : view.trusted
                        ? 'memory.state.on'
                        : 'memory.state.untrusted',
                  )}
                </span>
              }
            >
              <input
                id={projectId}
                type="checkbox"
                className="preference-switch"
                checked={locked ? view.enabled : view.projectEnabled}
                disabled={locked || busy}
                data-testid="memory-project-enabled"
                onChange={(e) => {
                  edit({ op: 'setEnabled', scope: 'project', enabled: e.currentTarget.checked });
                }}
              />
            </SettingsRow>
            {view.claude !== null && view.claude.count > 0 && (
              <SettingsRow
                testId="memory-import"
                label={t('memory.import.button')}
                description={t('memory.import.found', {
                  count: view.claude.count,
                  path: view.claude.path,
                })}
              >
                <Button
                  size="small"
                  disabled={busy}
                  data-testid="memory-import-button"
                  onClick={() => {
                    edit({ op: 'import' });
                  }}
                >
                  {t('memory.import.action')}
                </Button>
              </SettingsRow>
            )}
          </SettingsSection>
          <header className="settings-block-head">
            <h3>{t('memory.notes')}</h3>
          </header>
          {view.memories.length === 0 ? (
            <p className="muted" data-testid="memory-empty">
              {t('memory.empty')}
            </p>
          ) : (
            <>
              <div className="permission-filters">
                <label htmlFor={filterId} className="permission-filter-label">
                  {t('memory.filter')}
                </label>
                <select
                  id={filterId}
                  className="input"
                  value={filter}
                  data-testid="memory-filter"
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setFilter(TYPES.find((x) => x === value) ?? 'all');
                  }}
                >
                  <option value="all">{t('memory.filter.all')}</option>
                  {TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`memory.type.${x}`)}
                    </option>
                  ))}
                </select>
              </div>
              <ul className="memory-list" data-testid="memory-list">
                {view.memories
                  .filter((note) => filter === 'all' || note.type === filter)
                  .map((note) => (
                    <NoteRow
                      key={note.name}
                      note={note}
                      busy={busy}
                      opened={target?.note === note.name}
                      onEdit={(edited) => {
                        edit({
                          op: 'save',
                          name: edited.name,
                          type: edited.type,
                          description: edited.description,
                          content: edited.body,
                        });
                      }}
                      onDelete={(name) => {
                        edit({ op: 'delete', name });
                      }}
                    />
                  ))}
              </ul>
              <Button
                variant="destructive"
                size="small"
                className="memory-start"
                disabled={busy}
                data-testid="memory-delete-all"
                onClick={() => {
                  if (confirmAll) {
                    setConfirmAll(false);
                    edit({ op: 'deleteAll' });
                  } else {
                    setConfirmAll(true);
                  }
                }}
              >
                {t(confirmAll ? 'memory.deleteAllConfirm' : 'memory.deleteAll')}
              </Button>
            </>
          )}
        </>
      )}
    </div>
  );
}
