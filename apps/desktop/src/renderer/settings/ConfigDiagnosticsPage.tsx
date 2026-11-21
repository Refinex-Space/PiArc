// The Configuration diagnostics settings page (T24, architecture section 6.14): every settings
// file PiArc reads for a workspace, PiArc's and Claude Code's, with its load state, the keys
// it applies, the keys a higher file overrides (and which file), the keys PiArc ignores and
// why, and its parse errors. Core builds the report from the same load a permission decision
// uses; the page asks again whenever `core/settings` reports a change. Parts of the hooks
// configuration PiArc does not run (later events and handler types, `async`, matchers its
// regular expressions reject) are listed after the files (T25).
import { useCallback, useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';

const STATUSES = ['loaded', 'missing', 'invalid', 'stale', 'untrusted'] as const;
type FileStatus = (typeof STATUSES)[number];

const REASONS = [
  'unknown',
  'ignored',
  'planned',
  'untrusted',
  'projectMode',
  'projectSandbox',
  'platform',
] as const;
type IgnoreReason = (typeof REASONS)[number];

const LAYERS = [
  'projectLocal',
  'project',
  'claudeProjectLocal',
  'claudeProject',
  'user',
  'claudeUser',
  'claudeState',
] as const;

export interface KeyRow {
  readonly pointer: string;
  readonly value: unknown;
  readonly finalValue: unknown;
  readonly source?: string;
}

export interface IgnoredRow {
  readonly pointer: string;
  readonly reason: IgnoreReason;
  readonly task?: string;
}

export interface IssueRow {
  readonly message: string;
  readonly pointer: string;
  readonly line?: number;
  readonly column?: number;
}

export interface FileView {
  readonly layer: string;
  readonly file: string;
  readonly writable: boolean;
  /** Part of the merge (`~/.claude.json` is only listed). */
  readonly merged: boolean;
  readonly status: FileStatus;
  readonly effective: readonly KeyRow[];
  readonly overridden: readonly KeyRow[];
  readonly ignored: readonly IgnoredRow[];
  readonly issues: readonly IssueRow[];
}

/** A part of the hooks configuration PiArc does not run as written. */
export interface HookIssue {
  readonly layer: string;
  readonly file: string | undefined;
  readonly pointer: string;
  readonly message: string;
}

/** An MCP server PiArc cannot use (T36: SSE, WebSocket), or a definition it leaves out. */
export interface McpIssue {
  /** The server, for an unsupported one. */
  readonly name?: string;
  readonly source: string;
  /** Its transport (`sse`, `ws`), for an unsupported one. */
  readonly transport?: string;
  readonly pointer?: string;
  readonly message: string;
}

export interface DiagnosticsView {
  readonly workspaces: readonly string[];
  readonly workspace: string | null;
  readonly trusted: boolean;
  readonly files: readonly FileView[];
  readonly hooks: readonly HookIssue[];
  readonly mcp: readonly McpIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;

function one<T extends string>(values: readonly T[], v: unknown): T | undefined {
  return values.find((x) => x === v);
}

function keyRows(v: unknown): KeyRow[] {
  return list(v).flatMap((k): KeyRow[] => {
    const pointer = str(k.pointer);
    if (pointer === undefined) return [];
    const source = str(k.source);
    const row = { pointer, value: k.value, finalValue: k.finalValue };
    return [source === undefined ? row : { ...row, source }];
  });
}

/** Narrows Core's JSON report; unknown entries are dropped. */
export function parseDiagnostics(raw: string): DiagnosticsView {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Invalid configuration diagnostics');
  const files = list(value.files).flatMap((f): FileView[] => {
    const layer = str(f.layer);
    const file = str(f.file);
    const status = one(STATUSES, f.status);
    if (layer === undefined || file === undefined || status === undefined) return [];
    return [
      {
        layer,
        file,
        writable: f.writable === true,
        merged: typeof f.precedence === 'number',
        status,
        effective: keyRows(f.effective),
        overridden: keyRows(f.overridden),
        ignored: list(f.ignored).flatMap((k): IgnoredRow[] => {
          const pointer = str(k.pointer);
          const reason = one(REASONS, k.reason);
          if (pointer === undefined || reason === undefined) return [];
          const task = str(k.task);
          return [task === undefined ? { pointer, reason } : { pointer, reason, task }];
        }),
        issues: list(f.issues).flatMap((i): IssueRow[] => {
          const message = str(i.message);
          if (message === undefined) return [];
          const line = num(i.line);
          const column = num(i.column);
          return [
            {
              message,
              pointer: str(i.pointer) ?? '',
              ...(line === undefined ? {} : { line }),
              ...(column === undefined ? {} : { column }),
            },
          ];
        }),
      },
    ];
  });
  return {
    workspaces: Array.isArray(value.workspaces)
      ? value.workspaces.filter((w): w is string => typeof w === 'string')
      : [],
    workspace: str(value.workspace) ?? null,
    trusted: value.trusted === true,
    files,
    hooks: list(value.hooks).flatMap((h): HookIssue[] => {
      const layer = str(h.layer);
      const pointer = str(h.pointer);
      const message = str(h.message);
      if (layer === undefined || pointer === undefined || message === undefined) return [];
      return [{ layer, file: str(h.file), pointer, message }];
    }),
    mcp: mcpIssues(value.mcp),
  };
}

/** The MCP part of the report: unsupported servers first, then the merge's issues. */
function mcpIssues(value: unknown): McpIssue[] {
  if (!isRecord(value)) return [];
  const unsupported = list(value.unsupported).flatMap((u): McpIssue[] => {
    const name = str(u.name);
    const source = str(u.source);
    const message = str(u.reason);
    const transport = str(u.transport);
    if (name === undefined || source === undefined || message === undefined) return [];
    return [{ name, source, message, ...(transport === undefined ? {} : { transport }) }];
  });
  const issues = list(value.issues).flatMap((i): McpIssue[] => {
    const source = str(i.source);
    const message = str(i.message);
    if (source === undefined || message === undefined) return [];
    const pointer = str(i.pointer);
    return [{ source, message, ...(pointer === undefined ? {} : { pointer }) }];
  });
  return [...unsupported, ...issues];
}

function layerTitle(layer: string): MessageId | undefined {
  const known = one(LAYERS, layer);
  return known === undefined ? undefined : `diagnostics.layer.${known}`;
}

function json(value: unknown): string {
  // Core sends JSON values; a missing one (`undefined`) shows as null.
  return value === undefined ? 'null' : JSON.stringify(value);
}

function KeyTable({ rows, kind }: { rows: readonly KeyRow[]; kind: 'effective' | 'overridden' }) {
  const { t } = useApp();
  const source = (row: KeyRow): string => {
    if (row.source === undefined) return t('diagnostics.merged');
    const title = layerTitle(row.source);
    return title === undefined ? row.source : t(title);
  };
  return (
    <table className="diagnostics-table" data-testid={`diagnostics-${kind}`}>
      <thead>
        <tr>
          <th scope="col">{t('diagnostics.column.key')}</th>
          <th scope="col">{t('diagnostics.column.value')}</th>
          <th scope="col">{t('diagnostics.column.final')}</th>
          <th scope="col">
            {t(kind === 'effective' ? 'diagnostics.column.source' : 'diagnostics.column.by')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.pointer} data-testid="diagnostics-key" data-pointer={row.pointer}>
            <td className="diagnostics-code">{row.pointer}</td>
            <td className="diagnostics-code">{json(row.value)}</td>
            <td className="diagnostics-code">{json(row.finalValue)}</td>
            <td>{source(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function reasonText(t: ReturnType<typeof useApp>['t'], row: IgnoredRow): string {
  if (row.reason === 'planned' && row.task !== undefined) {
    return t('diagnostics.reason.plannedTask', { task: row.task });
  }
  return t(`diagnostics.reason.${row.reason}`);
}

function FileSection({ file }: { file: FileView }) {
  const { t } = useApp();
  const title = layerTitle(file.layer);
  const counts = {
    effective: file.effective.length,
    overridden: file.overridden.length,
    ignored: file.ignored.length,
    issues: file.issues.length,
  };
  return (
    <section
      className="diagnostics-file"
      data-testid={`diagnostics-file-${file.layer}`}
      data-status={file.status}
    >
      <h3 className="permission-source-title">
        {title === undefined ? file.layer : t(title)}
        <span className={`diagnostics-status is-${file.status}`} data-testid="diagnostics-status">
          {t(`diagnostics.status.${file.status}`)}
        </span>
        <span className="muted">
          {' '}
          · {t(file.writable ? 'diagnostics.writable' : 'diagnostics.readOnly')}
        </span>
      </h3>
      <div className="muted approval-path">{file.file}</div>
      {file.issues.length > 0 && (
        <ul className="diagnostics-issues" data-testid="diagnostics-issues">
          {file.issues.map((issue, index) => (
            <li key={index} className="error-text">
              {issue.line !== undefined && issue.column !== undefined && (
                <span>
                  {t('diagnostics.position', { line: issue.line, column: issue.column })}{' '}
                </span>
              )}
              {issue.pointer !== '' && <span className="diagnostics-code">{issue.pointer} </span>}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {file.status !== 'missing' && (
        <details className="diagnostics-details" data-testid="diagnostics-details">
          <summary>{t('diagnostics.summary', counts)}</summary>
          {/* `~/.claude.json` is not a settings layer, but its MCP servers apply (T36). */}
          {(file.merged || file.effective.length > 0) && (
            <>
              <h4>{t('diagnostics.effective')}</h4>
              {file.effective.length === 0 ? (
                <p className="muted">{t('diagnostics.none')}</p>
              ) : (
                <KeyTable rows={file.effective} kind="effective" />
              )}
            </>
          )}
          {file.merged && (
            <>
              <h4>{t('diagnostics.overridden')}</h4>
              {file.overridden.length === 0 ? (
                <p className="muted">{t('diagnostics.none')}</p>
              ) : (
                <KeyTable rows={file.overridden} kind="overridden" />
              )}
            </>
          )}
          <h4>{t('diagnostics.ignored')}</h4>
          {file.ignored.length === 0 ? (
            <p className="muted">{t('diagnostics.none')}</p>
          ) : (
            <ul className="diagnostics-ignored" data-testid="diagnostics-ignored">
              {file.ignored.map((row) => (
                <li
                  key={row.pointer}
                  data-testid="diagnostics-ignored-key"
                  data-pointer={row.pointer}
                >
                  <span className="diagnostics-code">{row.pointer}</span>{' '}
                  <span className="muted">{reasonText(t, row)}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}

function HookIssues({ issues }: { issues: readonly HookIssue[] }) {
  const { t } = useApp();
  return (
    <section className="diagnostics-file" data-testid="diagnostics-hooks">
      <h3 className="permission-source-title">{t('diagnostics.hooks')}</h3>
      <ul className="diagnostics-issues">
        {issues.map((issue) => {
          const title = layerTitle(issue.layer);
          return (
            <li
              key={`${issue.layer}${issue.pointer}`}
              data-testid="diagnostics-hook"
              data-pointer={issue.pointer}
            >
              <span className="muted">{title === undefined ? issue.layer : t(title)} </span>
              <span className="diagnostics-code">{issue.pointer} </span>
              {issue.message}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function McpIssues({ issues }: { issues: readonly McpIssue[] }) {
  const { t } = useApp();
  return (
    <section className="diagnostics-file" data-testid="diagnostics-mcp">
      <h3 className="permission-source-title">{t('diagnostics.mcp')}</h3>
      <ul className="diagnostics-issues">
        {issues.map((issue, index) => (
          <li
            key={`${issue.source}${issue.pointer ?? issue.name ?? ''}${String(index)}`}
            data-testid="diagnostics-mcp-issue"
            data-server={issue.name ?? ''}
          >
            {issue.name === undefined ? null : (
              <strong>
                {t('diagnostics.mcpUnsupported', {
                  name: issue.name,
                  transport:
                    issue.transport === 'ws' ? 'WebSocket' : (issue.transport ?? '').toUpperCase(),
                })}{' '}
              </strong>
            )}
            <span className="diagnostics-code">
              {issue.source}
              {issue.pointer === undefined || issue.pointer === '' ? '' : ` ${issue.pointer}`}{' '}
            </span>
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConfigDiagnosticsPage() {
  const { t } = useApp();
  const selectId = useId();
  const [view, setView] = useState<DiagnosticsView | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    window.piarc
      .configDiagnostics(chosen)
      .then((raw) => {
        setError('');
        setView(parseDiagnostics(raw));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [chosen]);
  useEffect(load, [load]);
  useEffect(() => {
    // A settings file of an open workspace changed: ask Core again.
    const route = 'core/settings';
    window.piarc.subscribeEvents(route, load).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      void window.piarc.unsubscribeEvents(route);
    };
  }, [load]);
  if (view === undefined) {
    return error === '' ? null : <p className="error-text">{error}</p>;
  }
  return (
    <div className="diagnostics-page" data-testid="config-diagnostics">
      <p className="muted">{t('diagnostics.intro')}</p>
      {view.workspace === null ? (
        <p className="muted">{t('permissions.noWorkspace')}</p>
      ) : (
        <>
          <div className="permission-filters">
            <label htmlFor={selectId} className="permission-filter-label">
              {t('permissions.workspace')}
            </label>
            <select
              id={selectId}
              className="input"
              value={view.workspace}
              data-testid="diagnostics-workspace"
              onChange={(e) => {
                setChosen(e.currentTarget.value);
              }}
            >
              {view.workspaces.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button"
              onClick={load}
              data-testid="diagnostics-refresh"
            >
              {t('permissions.audit.refresh')}
            </button>
          </div>
          <p className="muted" data-testid="diagnostics-trust">
            {t(view.trusted ? 'diagnostics.trusted' : 'diagnostics.untrusted')}
          </p>
          {error !== '' && <p className="error-text">{error}</p>}
          {view.files.map((file) => (
            <FileSection key={file.layer} file={file} />
          ))}
          {view.hooks.length > 0 && <HookIssues issues={view.hooks} />}
          {view.mcp.length > 0 && <McpIssues issues={view.mcp} />}
        </>
      )}
    </div>
  );
}
