// The MCP servers of a workspace (T36, architecture section 6.8): where each is defined, how it
// is reached, its state in the workspace's pool, how many tools it offers and its last error,
// with reconnect, turn on, turn off and sign in. Core stores the on/off choice per workspace;
// the pool's state arrives on `core/mcp`, a sign-in's steps on `core/login`.
import { PageHeadActions } from './page-head.js';
import { ScopePicker } from './ScopePicker.js';
import { SettingsInfo, SettingsSection } from './layout.js';
import { McpAddDialog } from './McpAddDialog.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { PlusIcon, ReloadIcon } from '../shell/icons.js';
import type { McpServerStatus, McpStatus } from '@piarc/protocol';
import { WorkspaceOptions } from './WorkspaceOptions.js';
import { Fragment, useCallback, useEffect, useId, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { useSignInDialog } from './SignInSection.js';
import { Button } from '../app/Button.js';

const STATES = [
  'connected',
  'connecting',
  'idle',
  'needsAuth',
  'failed',
  'disabled',
  'unsupported',
  'untrusted',
] as const;
const SCOPES = ['enterprise', 'local', 'project', 'user', 'plugin', 'subagent'] as const;
const TRANSPORTS = ['stdio', 'http', 'sse', 'ws'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((v) => v === value);
}

function parseServer(value: unknown): McpServerStatus | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.source !== 'string') {
    return undefined;
  }
  const state = oneOf(STATES, value.state);
  const scope = oneOf(SCOPES, value.scope);
  const transport = oneOf(TRANSPORTS, value.transport);
  if (state === undefined || scope === undefined || transport === undefined) return undefined;
  return {
    name: value.name,
    source: value.source,
    state,
    scope,
    transport,
    tools: typeof value.tools === 'number' ? value.tools : 0,
    sessions: typeof value.sessions === 'number' ? value.sessions : 0,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(value.oauth === true ? { oauth: true } : {}),
  };
}

/** Core's `McpStatus` (also `core/mcp`'s payload), with the members this page reads checked. */
export function parseStatus(value: unknown): McpStatus | undefined {
  if (!isRecord(value) || !Array.isArray(value.servers)) return undefined;
  const servers = value.servers.flatMap((s: unknown) => {
    const server = parseServer(s);
    return server === undefined ? [] : [server];
  });
  const overridden = (Array.isArray(value.overridden) ? value.overridden : []).flatMap(
    (o: unknown) =>
      isRecord(o) &&
      typeof o.name === 'string' &&
      typeof o.source === 'string' &&
      typeof o.by === 'string'
        ? [{ name: o.name, source: o.source, by: o.by }]
        : [],
  );
  const issues = (Array.isArray(value.issues) ? value.issues : []).flatMap((i: unknown) =>
    isRecord(i) &&
    typeof i.source === 'string' &&
    typeof i.pointer === 'string' &&
    typeof i.message === 'string'
      ? [{ source: i.source, pointer: i.pointer, message: i.message }]
      : [],
  );
  return { servers, overridden, issues };
}

/** The workspaces the diagnostics know (the open and recent ones) and the default one. */
function parseWorkspaces(text: string): { workspace: string | null; workspaces: string[] } {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) return { workspace: null, workspaces: [] };
  const workspaces = Array.isArray(value.workspaces)
    ? value.workspaces.filter((w: unknown): w is string => typeof w === 'string')
    : [];
  return {
    workspace: typeof value.workspace === 'string' ? value.workspace : null,
    workspaces,
  };
}

/** The `core/mcp` payloads of one batch that concern `workspace`. */
function updatesFor(payload: Uint8Array, workspace: string): McpStatus[] {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((event: unknown) => {
      if (!isRecord(event) || event.workspace !== workspace) return [];
      const status = parseStatus(event);
      return status === undefined ? [] : [status];
    });
  } catch {
    return [];
  }
}

/** Which servers the list shows: every one, the ones every project gets, or this project's. */
type Filter = 'all' | 'allProjects' | 'thisProject';
const FILTERS: readonly Filter[] = ['all', 'allProjects', 'thisProject'];
/** Scopes that apply only to this project; the others (user, managed, plugin) apply to all. */
const PROJECT_SCOPES = new Set(['project', 'local', 'subagent']);

function shownBy(filter: Filter, server: McpServerStatus): boolean {
  if (filter === 'all') return true;
  return PROJECT_SCOPES.has(server.scope) === (filter === 'thisProject');
}

const RUNNING = new Set(['connected', 'connecting', 'idle', 'needsAuth', 'failed']);
/** States that need the user's eye: named next to the server instead of in its details. */
const FLAGGED = new Set(['needsAuth', 'failed', 'unsupported', 'untrusted']);

function ServerRow({
  server,
  busy,
  onReconnect,
  onEnabled,
  onSignIn,
}: {
  readonly server: McpServerStatus;
  readonly busy: boolean;
  readonly onReconnect: () => void;
  readonly onEnabled: (enabled: boolean) => void;
  readonly onSignIn: () => void;
}) {
  const { t } = useApp();
  const running = RUNNING.has(server.state);
  const flagged = FLAGGED.has(server.state);
  const state = (
    <span
      className={flagged ? `settings-badge mcp-state is-${server.state}` : 'mcp-state'}
      data-testid="mcp-state"
    >
      {t(`mcp.state.${server.state}`)}
    </span>
  );
  const signIn =
    server.state === 'needsAuth' || (server.oauth === true && server.state === 'failed');
  const switchable = running || server.state === 'disabled';
  return (
    <li
      className="mcp-server"
      data-testid="mcp-server"
      data-name={server.name}
      data-state={server.state}
    >
      <span className={`mcp-dot is-${server.state}`} aria-hidden="true" />
      <div className="mcp-server-text">
        <div className="mcp-server-name">
          <span className="mono-text">{server.name}</span>
          {flagged ? state : null}
        </div>
        <div className="mcp-server-meta">
          {[
            <span
              key="scope"
              data-tooltip={server.source}
              data-testid="mcp-source"
              data-source={server.source}
            >
              {t(`mcp.scope.${server.scope}`)}
            </span>,
            <span key="transport">{t(`mcp.transport.${server.transport}`)}</span>,
            server.state === 'unsupported' ? null : (
              <span key="tools" data-testid="mcp-tools">
                {t('mcp.tools', { count: server.tools })}
              </span>
            ),
            server.sessions > 0 ? (
              <span key="sessions">{t('mcp.sessions', { count: server.sessions })}</span>
            ) : null,
            flagged ? null : <Fragment key="state">{state}</Fragment>,
          ]
            .filter((part) => part !== null)
            .flatMap((part, i) => (i === 0 ? [part] : [' · ', part]))}
        </div>
        {server.error == null ? null : (
          <p className="mcp-error" data-testid="mcp-error" data-tooltip={server.error}>
            {server.error}
          </p>
        )}
      </div>
      <div className="mcp-server-actions">
        {signIn ? (
          <Button size="small" data-testid="mcp-sign-in" disabled={busy} onClick={onSignIn}>
            {t('mcp.signIn')}
          </Button>
        ) : running ? (
          <Button
            variant="ghost"
            size="small"
            data-testid="mcp-reconnect"
            disabled={busy}
            onClick={onReconnect}
          >
            {t('mcp.reconnect')}
          </Button>
        ) : null}
        {switchable ? (
          <input
            type="checkbox"
            className="preference-switch"
            checked={running}
            disabled={busy}
            aria-label={t('mcp.enabledNamed', { name: server.name })}
            data-testid={running ? 'mcp-disable' : 'mcp-enable'}
            onChange={(e) => {
              onEnabled(e.currentTarget.checked);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

export function McpPage() {
  const { t } = useApp();
  const selectId = useId();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  useEffect(() => {
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        const known = parseWorkspaces(raw);
        setWorkspaces(known.workspaces);
        setChosen((current) => current ?? known.workspace);
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
  }, []);
  const load = useCallback(() => {
    if (chosen === null) return;
    window.piarc
      .mcpStatus(chosen)
      .then((raw) => {
        setError('');
        setStatus(parseStatus(JSON.parse(raw)));
      })
      .catch((e: unknown) => {
        setError(t('mcp.failed', { reason: reason(e) }));
      });
  }, [chosen, t]);
  useEffect(() => {
    setStatus(undefined);
    load();
  }, [load]);
  useEffect(() => {
    if (chosen === null) return;
    const route = 'core/mcp';
    window.piarc
      .subscribeEvents(route, (batch) => {
        const latest = updatesFor(batch.payload, chosen).at(-1);
        if (latest !== undefined) setStatus(latest);
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
    return () => {
      void window.piarc.unsubscribeEvents(route);
    };
  }, [chosen]);
  const signIn = useSignInDialog(load);
  const act = (run: () => Promise<string>) => {
    setBusy(true);
    run()
      .then(
        () => {
          setError('');
          load();
        },
        (e: unknown) => {
          setError(t('mcp.failed', { reason: reason(e) }));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="settings-detail-page mcp-page" data-testid="mcp-page">
      <PageHeadActions>
        <SettingsInfo text={t('mcp.hint')} />
      </PageHeadActions>
      {chosen === null ? (
        <p className="muted">{t('mcp.noWorkspace')}</p>
      ) : (
        <PageHeadActions>
          <ScopePicker>
            <select
              id={selectId}
              aria-label={t('permissions.workspace')}
              className="settings-scope-select"
              value={chosen}
              data-testid="mcp-workspace"
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
      {signIn.failure === '' ? null : (
        <p className="error-text" role="alert">
          {signIn.failure}
        </p>
      )}
      {status === undefined ? (
        chosen === null || error !== '' ? null : (
          <p className="muted">{t('mcp.loading')}</p>
        )
      ) : (
        <>
          <SettingsSection
            title={t('mcp.servers')}
            testId="mcp-servers-section"
            aside={
              <>
                {status.servers.length === 0 ? null : (
                  <SegmentedControl<Filter>
                    aria-label={t('mcp.filter')}
                    name="mcp-filter"
                    options={FILTERS}
                    value={filter}
                    labelOf={(f) => t(`mcp.filter.${f}`)}
                    onChange={setFilter}
                    testIdPrefix="mcp-filter"
                  />
                )}
                {status.servers.some((s) => RUNNING.has(s.state)) ? (
                  <Button
                    variant="ghost"
                    size="small"
                    data-testid="mcp-reconnect-all"
                    disabled={busy || signIn.open}
                    onClick={() => {
                      const workspace = chosen ?? '';
                      act(async () => {
                        let last = '';
                        for (const s of status.servers.filter((s) => RUNNING.has(s.state))) {
                          last = await window.piarc.mcpReconnect(workspace, s.name);
                        }
                        return last;
                      });
                    }}
                  >
                    <ReloadIcon />
                    {t('mcp.reconnectAll')}
                  </Button>
                ) : null}
              </>
            }
          >
            <ul className="mcp-servers" data-testid="mcp-servers">
              {status.servers.length === 0 ? (
                <li className="mcp-empty muted" data-testid="mcp-empty">
                  {t('mcp.empty')}
                </li>
              ) : null}
              {status.servers.length > 0 &&
              !status.servers.some((server) => shownBy(filter, server)) ? (
                <li className="mcp-empty muted" data-testid="mcp-filter-empty">
                  {t('mcp.filter.empty')}
                </li>
              ) : null}
              {status.servers
                .filter((server) => shownBy(filter, server))
                .map((server) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    busy={busy || signIn.open}
                    onReconnect={() => {
                      act(() => window.piarc.mcpReconnect(chosen ?? '', server.name));
                    }}
                    onEnabled={(enabled) => {
                      act(() => window.piarc.mcpSetEnabled(chosen ?? '', server.name, enabled));
                    }}
                    onSignIn={() => {
                      const workspace = chosen ?? '';
                      signIn.start(
                        {
                          id: `mcp:${server.name}`,
                          name: server.name,
                          label: '',
                          subscription: false,
                          signedIn: false,
                        },
                        () => window.piarc.mcpLogin(workspace, server.name),
                      );
                    }}
                  />
                ))}
              <li className="mcp-add-row">
                <button
                  type="button"
                  className="settings-add-link"
                  data-testid="mcp-add"
                  disabled={busy || chosen === null}
                  onClick={() => {
                    setAdding(true);
                  }}
                >
                  <PlusIcon />
                  {t('mcp.add')}
                </button>
              </li>
            </ul>
          </SettingsSection>
          {(status.overridden ?? []).length === 0 ? null : (
            <SettingsSection title={t('mcp.overridden')} testId="mcp-overridden">
              <ul className="mcp-notes">
                {(status.overridden ?? []).map((o) => (
                  <li key={`${o.name}:${o.source}`}>
                    {t('mcp.overriddenBy', { name: o.name, source: o.source, by: o.by })}
                  </li>
                ))}
              </ul>
            </SettingsSection>
          )}
          {(status.issues ?? []).length === 0 ? null : (
            <SettingsSection title={t('mcp.issues')} testId="mcp-issues">
              <ul className="mcp-notes">
                {(status.issues ?? []).map((i, index) => (
                  <li key={`${i.source}${i.pointer}${String(index)}`}>
                    <span className="mono-text" data-tooltip={i.source}>
                      {i.pointer || i.source}
                    </span>{' '}
                    {i.message}
                  </li>
                ))}
              </ul>
            </SettingsSection>
          )}
        </>
      )}
      {signIn.dialog}
      {adding && chosen !== null ? (
        <McpAddDialog
          workspace={chosen}
          taken={[
            ...(status?.servers ?? []).map((s) => s.name),
            ...(status?.overridden ?? []).map((o) => o.name),
          ]}
          onClose={() => {
            setAdding(false);
          }}
          onAdded={(raw) => {
            setAdding(false);
            const next = parseStatus(JSON.parse(raw));
            if (next !== undefined) setStatus(next);
            else load();
          }}
        />
      ) : null}
    </div>
  );
}
