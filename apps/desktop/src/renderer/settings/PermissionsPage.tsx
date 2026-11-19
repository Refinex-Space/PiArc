// The Permissions settings page (T23): rules by source with add, edit and remove for PiArc's
// writable files, syntax checks while typing and hints for broad rules, the Bypass mode
// switch, and the audit of permission decisions. Core parses and saves; the main process
// shows the native confirmation for new or changed allow rules.
import { useCallback, useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import {
  RULE_LAYERS,
  type AuditQuery,
  type RuleBehavior,
  type RuleLayer,
} from '../../shared/ipc.js';
import { useApp } from '../app/app-context.js';

const BEHAVIORS: readonly RuleBehavior[] = ['deny', 'ask', 'allow'];

interface RuleRow {
  readonly behavior: RuleBehavior;
  readonly rule: string;
  readonly error?: string;
  readonly broad: boolean;
  readonly inactive: boolean;
}

interface SourceView {
  readonly id: string;
  readonly file?: string;
  readonly sessionId?: string;
  readonly writable: boolean;
  readonly rules: readonly RuleRow[];
}

interface PermissionView {
  readonly workspaces: readonly string[];
  readonly workspace: string | null;
  readonly sources: readonly SourceView[];
}

interface AuditRow {
  readonly at: number;
  readonly sessionId: string | undefined;
  readonly tool: string | undefined;
  readonly step: string | undefined;
  readonly conclusion: string | undefined;
  readonly rule: string | undefined;
  readonly ruleSource: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function isBehavior(v: unknown): v is RuleBehavior {
  return v === 'allow' || v === 'ask' || v === 'deny';
}

export function parseView(raw: string): PermissionView {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Invalid permission view');
  const sources = Array.isArray(value.sources) ? value.sources.filter(isRecord) : [];
  return {
    workspaces: Array.isArray(value.workspaces)
      ? value.workspaces.filter((w): w is string => typeof w === 'string')
      : [],
    workspace: str(value.workspace) ?? null,
    sources: sources.map((s): SourceView => {
      const file = str(s.file);
      const sessionId = str(s.sessionId);
      const rules = (Array.isArray(s.rules) ? s.rules.filter(isRecord) : []).flatMap(
        (r): RuleRow[] => {
          const rule = str(r.rule);
          if (rule === undefined || !isBehavior(r.behavior)) return [];
          const error = str(r.error);
          const row = {
            behavior: r.behavior,
            rule,
            broad: r.broad === true,
            inactive: r.inactive === true,
          };
          return [error === undefined ? row : { ...row, error }];
        },
      );
      const base = { id: str(s.id) ?? '', writable: s.writable === true, rules };
      return {
        ...base,
        ...(file === undefined ? {} : { file }),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }),
  };
}

export function parseAudit(raw: string): AuditRow[] {
  const value: unknown = JSON.parse(raw);
  const events = isRecord(value) && Array.isArray(value.events) ? value.events : [];
  return events.filter(isRecord).map((e): AuditRow => {
    const d = isRecord(e.detail) ? e.detail : {};
    return {
      at: typeof e.at === 'number' ? e.at : 0,
      sessionId: str(e.sessionId),
      tool: str(d.tool),
      step: str(d.step),
      conclusion: str(d.conclusion),
      rule: str(d.rule),
      ruleSource: str(d.ruleSource),
    };
  });
}

function sourceTitle(id: string): MessageId | undefined {
  switch (id) {
    case 'session':
    case 'projectLocal':
    case 'project':
    case 'user':
      return `permissions.source.${id}`;
    default:
      return undefined;
  }
}

function isLayer(id: string): id is RuleLayer {
  return RULE_LAYERS.some((l) => l === id);
}

function RuleEditor({
  initial,
  behavior,
  onSave,
  onCancel,
  fixed = false,
}: {
  readonly initial: string;
  readonly behavior: RuleBehavior;
  readonly onSave: (rule: string, behavior: RuleBehavior) => void;
  readonly onCancel?: () => void;
  /** Editing keeps the rule in its list. */
  readonly fixed?: boolean;
}) {
  const { t } = useApp();
  const [text, setText] = useState(initial);
  const [list, setList] = useState<RuleBehavior>(behavior);
  const [check, setCheck] = useState<{ error?: string; broad: boolean } | undefined>(undefined);
  useEffect(() => {
    const rule = text.trim();
    if (rule === '') {
      setCheck(undefined);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      window.piarc
        .checkPermissionRule(rule, list)
        .then((raw) => {
          const value: unknown = JSON.parse(raw);
          if (!live || !isRecord(value)) return;
          const error = str(value.error);
          setCheck({ broad: value.broad === true, ...(error === undefined ? {} : { error }) });
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, list]);
  const valid = text.trim() !== '' && check !== undefined && check.error === undefined;
  return (
    <div className="permission-editor" data-testid="permission-editor">
      <select
        className="input"
        value={list}
        disabled={fixed}
        aria-label={t('permissions.rules')}
        data-testid="permission-behavior"
        onChange={(e) => {
          const next = BEHAVIORS.find((b) => b === e.currentTarget.value);
          if (next !== undefined) setList(next);
        }}
      >
        {BEHAVIORS.map((b) => (
          <option key={b} value={b}>
            {t(`permissions.behavior.${b}`)}
          </option>
        ))}
      </select>
      <input
        className="input"
        value={text}
        placeholder={t('permissions.newRule')}
        aria-label={t('permissions.newRule')}
        data-testid="permission-rule-input"
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <button
        type="button"
        className="button"
        disabled={!valid}
        data-testid="permission-save"
        onClick={() => {
          onSave(text.trim(), list);
        }}
      >
        {t('permissions.save')}
      </button>
      {onCancel && (
        <button type="button" className="button" onClick={onCancel}>
          {t('dialog.cancel')}
        </button>
      )}
      {check?.error !== undefined && (
        <p className="error-text" role="alert" data-testid="permission-check">
          {t('permissions.invalid', { reason: check.error })}
        </p>
      )}
      {check?.error === undefined && check?.broad === true && list === 'allow' && (
        <p className="muted" data-testid="permission-broad">
          {t('permissions.broad')}
        </p>
      )}
    </div>
  );
}

function SourceSection({
  source,
  workspace,
  onChanged,
  onError,
}: {
  readonly source: SourceView;
  readonly workspace: string;
  readonly onChanged: (raw: string) => void;
  readonly onError: (error: unknown) => void;
}) {
  const { t } = useApp();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const layer = isLayer(source.id) ? source.id : undefined;
  const title = sourceTitle(source.id);
  const change = (behavior: RuleBehavior, old?: string, rule?: string) => {
    if (layer === undefined) return;
    window.piarc
      .updatePermissionRule({
        workspace,
        layer,
        behavior,
        ...(old === undefined ? {} : { old }),
        ...(rule === undefined ? {} : { rule }),
      })
      .then((raw) => {
        const value: unknown = JSON.parse(raw);
        if (isRecord(value) && value.status === 'cancelled') return;
        setEditing(undefined);
        setAdding(false);
        onChanged(raw);
      })
      .catch(onError);
  };
  return (
    <section className="settings-section" data-testid={`permission-source-${source.id}`}>
      <h2 className="setting-label">
        {title === undefined ? source.id : t(title)}
        {source.sessionId !== undefined && <span className="muted"> · {source.sessionId}</span>}
        {!source.writable && <span className="muted"> · {t('permissions.readOnly')}</span>}
      </h2>
      {source.file !== undefined && <div className="muted approval-path">{source.file}</div>}
      {source.rules.length === 0 && <p className="muted">{t('permissions.empty')}</p>}
      <ul className="permission-rules">
        {source.rules.map((r) => {
          const key = `${r.behavior}:${r.rule}`;
          return (
            <li key={key} className="permission-rule" data-testid="permission-rule">
              {editing === key ? (
                <RuleEditor
                  initial={r.rule}
                  behavior={r.behavior}
                  fixed
                  onCancel={() => {
                    setEditing(undefined);
                  }}
                  onSave={(rule) => {
                    change(r.behavior, r.rule, rule);
                  }}
                />
              ) : (
                <>
                  <span className={`permission-badge is-${r.behavior}`}>
                    {t(`permissions.behavior.${r.behavior}`)}
                  </span>{' '}
                  <code>{r.rule}</code>
                  {r.error !== undefined && (
                    <span className="error-text">
                      {' '}
                      {t('permissions.invalid', { reason: r.error })}
                    </span>
                  )}
                  {r.broad && r.behavior === 'allow' && (
                    <span className="muted"> {t('permissions.broad')}</span>
                  )}
                  {r.inactive && <span className="muted"> {t('permissions.inactive')}</span>}
                  {source.writable && (
                    <span className="permission-actions">
                      <button
                        type="button"
                        className="row-action"
                        onClick={() => {
                          setEditing(key);
                        }}
                      >
                        {t('permissions.edit')}
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        onClick={() => {
                          change(r.behavior, r.rule, undefined);
                        }}
                      >
                        {t('permissions.remove')}
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {source.writable &&
        (adding ? (
          <RuleEditor
            initial=""
            behavior="allow"
            onCancel={() => {
              setAdding(false);
            }}
            onSave={(rule, behavior) => {
              change(behavior, undefined, rule);
            }}
          />
        ) : (
          <button
            type="button"
            className="button"
            data-testid={`permission-add-${source.id}`}
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('permissions.add')}
          </button>
        ))}
    </section>
  );
}

const SINCE = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const;
type Since = keyof typeof SINCE | 'all';

function AuditSection({ workspace }: { readonly workspace: string }) {
  const { t } = useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [session, setSession] = useState('');
  const [tool, setTool] = useState('');
  const [conclusion, setConclusion] = useState<'' | 'allow' | 'deny'>('');
  const [since, setSince] = useState<Since>('all');
  const [error, setError] = useState('');
  const ids = { session: useId(), tool: useId(), conclusion: useId(), since: useId() };
  const load = useCallback(() => {
    const query: AuditQuery = {
      workspace,
      ...(session.trim() === '' ? {} : { sessionId: session.trim() }),
      ...(tool.trim() === '' ? {} : { tool: tool.trim() }),
      ...(conclusion === '' ? {} : { conclusion }),
      ...(since === 'all' ? {} : { since: Date.now() - SINCE[since] }),
      limit: 200,
    };
    window.piarc
      .auditEvents(query)
      .then((raw) => {
        setError('');
        setRows(parseAudit(raw));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [workspace, session, tool, conclusion, since]);
  useEffect(load, [load]);
  return (
    <section className="settings-section" data-testid="permission-audit">
      <h2 className="setting-label">{t('permissions.audit')}</h2>
      <div className="permission-filters">
        <label htmlFor={ids.session}>{t('permissions.audit.session')}</label>
        <input
          id={ids.session}
          className="input"
          value={session}
          data-testid="audit-session"
          onChange={(e) => {
            setSession(e.target.value);
          }}
        />
        <label htmlFor={ids.tool}>{t('permissions.audit.tool')}</label>
        <input
          id={ids.tool}
          className="input"
          value={tool}
          data-testid="audit-tool"
          onChange={(e) => {
            setTool(e.target.value);
          }}
        />
        <label htmlFor={ids.conclusion}>{t('permissions.audit.conclusion')}</label>
        <select
          id={ids.conclusion}
          className="input"
          value={conclusion}
          data-testid="audit-conclusion"
          onChange={(e) => {
            const v = e.currentTarget.value;
            setConclusion(v === 'allow' || v === 'deny' ? v : '');
          }}
        >
          <option value="">{t('permissions.audit.all')}</option>
          <option value="allow">{t('permissions.audit.allow')}</option>
          <option value="deny">{t('permissions.audit.deny')}</option>
        </select>
        <label htmlFor={ids.since}>{t('permissions.audit.since')}</label>
        <select
          id={ids.since}
          className="input"
          value={since}
          data-testid="audit-since"
          onChange={(e) => {
            const v = e.currentTarget.value;
            setSince(v === 'hour' || v === 'day' || v === 'week' ? v : 'all');
          }}
        >
          <option value="all">{t('permissions.audit.all')}</option>
          <option value="hour">{t('permissions.audit.hour')}</option>
          <option value="day">{t('permissions.audit.day')}</option>
          <option value="week">{t('permissions.audit.week')}</option>
        </select>
        <button type="button" className="button" onClick={load}>
          {t('permissions.audit.refresh')}
        </button>
      </div>
      {error !== '' && <p className="error-text">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted">{t('permissions.audit.empty')}</p>
      ) : (
        <table className="permission-audit-table">
          <thead>
            <tr>
              <th>{t('permissions.audit.time')}</th>
              <th>{t('permissions.audit.session')}</th>
              <th>{t('permissions.audit.tool')}</th>
              <th>{t('permissions.audit.step')}</th>
              <th>{t('permissions.audit.rule')}</th>
              <th>{t('permissions.audit.conclusion')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${String(r.at)}-${String(i)}`} data-testid="audit-row">
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>{r.sessionId ?? ''}</td>
                <td>{r.tool ?? ''}</td>
                <td>{r.step ?? ''}</td>
                <td>
                  {r.rule === undefined ? '' : <code>{r.rule}</code>}
                  {r.ruleSource === undefined ? '' : ` · ${r.ruleSource}`}
                </td>
                <td>
                  {r.conclusion === 'allow'
                    ? t('permissions.audit.allow')
                    : r.conclusion === 'deny'
                      ? t('permissions.audit.deny')
                      : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PermissionsPage() {
  const { t, preferences } = useApp();
  const [view, setView] = useState<PermissionView | undefined>(undefined);
  const [error, setError] = useState('');
  const workspaceId = useId();
  const report = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  };
  const show = (raw: string) => {
    setError('');
    setView(parseView(raw));
  };
  const load = (workspace: string | null) => {
    window.piarc.permissionRules(workspace).then(show).catch(report);
  };
  useEffect(() => {
    load(null);
  }, []);
  const workspace = view?.workspace ?? null;
  return (
    <div className="settings-section" data-testid="permissions-page">
      <div className="setting">
        <span className="setting-label">{t('approval.modeMenu')}</span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={preferences.permissions.enableBypassPermissions}
            data-testid="setting-enable-bypass"
            onChange={(event) => {
              window.piarc
                .setPreference({
                  key: 'permissions.enableBypassPermissions',
                  value: event.currentTarget.checked,
                })
                .catch(report);
            }}
          />
          {t('permissions.bypass.enable')}
        </label>
        <p className="muted">{t('permissions.bypass.hint')}</p>
      </div>
      {view !== undefined && view.workspaces.length > 0 && (
        <div className="setting">
          <label htmlFor={workspaceId} className="setting-label">
            {t('permissions.workspace')}
          </label>
          <select
            id={workspaceId}
            className="input"
            value={workspace ?? ''}
            data-testid="permission-workspace"
            onChange={(e) => {
              load(e.currentTarget.value);
            }}
          >
            {view.workspaces.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
      )}
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {view !== undefined && workspace === null && (
        <p className="muted">{t('permissions.noWorkspace')}</p>
      )}
      {view !== undefined && workspace !== null && (
        <>
          <h2 className="setting-label">{t('permissions.rules')}</h2>
          {view.sources.map((source) => (
            <SourceSection
              key={`${source.id}:${source.sessionId ?? ''}`}
              source={source}
              workspace={workspace}
              onChanged={show}
              onError={report}
            />
          ))}
          <AuditSection workspace={workspace} />
        </>
      )}
    </div>
  );
}
