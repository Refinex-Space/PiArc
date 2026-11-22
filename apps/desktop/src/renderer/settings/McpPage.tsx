// The MCP servers of a workspace (T36, architecture section 6.8): where each is defined, how it
// is reached, its state in the workspace's pool, how many tools it offers and its last error,
// with reconnect, turn on, turn off and sign in. Core stores the on/off choice per workspace;
// the pool's state arrives on `core/mcp`, a sign-in's steps on `core/login`.
import type { McpServerStatus, McpStatus } from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { useSignInDialog } from './SignInSection.js';

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

const RUNNING = new Set(['connected', 'connecting', 'idle', 'needsAuth', 'failed']);

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
  return (
    <li
      className="agent-row"
      data-testid="mcp-server"
      data-name={server.name}
      data-state={server.state}
    >
      <div className="agent-row-head">
        <strong>{server.name}</strong>
        <span className={`mcp-state is-${server.state}`} data-testid="mcp-state">
          {t(`mcp.state.${server.state}`)}
        </span>
      </div>
      <div className="muted small">
        {t(`mcp.transport.${server.transport}`)}
        {' · '}
        {t(`mcp.scope.${server.scope}`)}
        {server.state === 'unsupported' ? null : (
          <>
            {' · '}
            <span data-testid="mcp-tools">{t('mcp.tools', { count: server.tools })}</span>
          </>
        )}
        {server.sessions > 0 ? ` · ${t('mcp.sessions', { count: server.sessions })}` : ''}
      </div>
      <div className="muted small diagnostics-code" data-testid="mcp-source">
        {server.source}
      </div>
      {server.error == null ? null : (
        <pre className="mcp-error small" data-testid="mcp-error">
          {server.error}
        </pre>
      )}
      <div className="dialog-actions mcp-actions">
        {server.state === 'needsAuth' || (server.oauth === true && server.state === 'failed') ? (
          <button
            type="button"
            className="button button-primary"
            data-testid="mcp-sign-in"
            disabled={busy}
            onClick={onSignIn}
          >
            {t('mcp.signIn')}
          </button>
        ) : null}
        {running ? (
          <button
            type="button"
            className="button"
            data-testid="mcp-reconnect"
            disabled={busy}
            onClick={onReconnect}
          >
            {t('mcp.reconnect')}
          </button>
        ) : null}
        {running ? (
          <button
            type="button"
            className="button"
            data-testid="mcp-disable"
            disabled={busy}
            onClick={() => {
              onEnabled(false);
            }}
          >
            {t('mcp.disable')}
          </button>
        ) : server.state === 'disabled' ? (
          <button
            type="button"
            className="button"
            data-testid="mcp-enable"
            disabled={busy}
            onClick={() => {
              onEnabled(true);
            }}
          >
            {t('mcp.enable')}
          </button>
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
    <div className="agents-page" data-testid="mcp-page">
      <p className="muted">{t('mcp.hint')}</p>
      {chosen === null ? (
        <p className="muted">{t('mcp.noWorkspace')}</p>
      ) : (
        <div className="permission-filters">
          <label htmlFor={selectId} className="permission-filter-label">
            {t('permissions.workspace')}
          </label>
          <select
            id={selectId}
            className="input"
            value={chosen}
            data-testid="mcp-workspace"
            onChange={(e) => {
              setChosen(e.currentTarget.value);
            }}
          >
            {workspaces.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
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
          <h2 className="settings-heading">{t('mcp.title')}</h2>
          {status.servers.length === 0 ? (
            <p className="muted" data-testid="mcp-empty">
              {t('mcp.empty')}
            </p>
          ) : (
            <ul className="agent-list" data-testid="mcp-servers">
              {status.servers.map((server) => (
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
            </ul>
          )}
          {(status.overridden ?? []).length === 0 ? null : (
            <section data-testid="mcp-overridden">
              <h2 className="settings-heading">{t('mcp.overridden')}</h2>
              <ul>
                {(status.overridden ?? []).map((o) => (
                  <li key={`${o.name}:${o.source}`} className="muted small">
                    {t('mcp.overriddenBy', { name: o.name, source: o.source, by: o.by })}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(status.issues ?? []).length === 0 ? null : (
            <section data-testid="mcp-issues">
              <h2 className="settings-heading">{t('mcp.issues')}</h2>
              <ul>
                {(status.issues ?? []).map((i, index) => (
                  <li key={`${i.source}${i.pointer}${String(index)}`} className="error-text">
                    <span className="diagnostics-code">
                      {i.source} {i.pointer}
                    </span>{' '}
                    {i.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {signIn.dialog}
    </div>
  );
}
