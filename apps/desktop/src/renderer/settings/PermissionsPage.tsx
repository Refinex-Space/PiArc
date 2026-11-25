// The Permissions settings page (T23): rules by source with add, edit and remove for PiArc's
// writable files, syntax checks while typing and hints for broad rules, the Bypass mode
// switch, and the audit of permission decisions. Core parses and saves; the main process
// shows the native confirmation for new or changed allow rules.
import { useCallback, useEffect, useId, useState } from 'react';
import { WorkspaceOptions } from './WorkspaceOptions.js';

import type { MessageId } from '../../shared/i18n/index.js';
import {
  RULE_LAYERS,
  type AuditQuery,
  type RuleBehavior,
  type RuleLayer,
} from '../../shared/ipc.js';
import { useApp } from '../app/app-context.js';
import { AutoReviewSection } from './AutoReviewSection.js';
import { ManagedBadge, useIsManaged } from './managed.js';
import { revealBidi } from '../transcript/reveal.js';
import { Button } from '../app/Button.js';

const BEHAVIORS: readonly RuleBehavior[] = ['deny', 'ask', 'allow'];

interface RuleRow {
  readonly behavior: RuleBehavior;
  readonly rule: string;
  readonly error?: string;
  /** The rule that matches what this one names, when it can never match (I85). */
  readonly suggestion?: string;
  /** The call argument a parameter rule matches (`Agent(model:opus)`, I82). */
  readonly parameter?: string;
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
  /** An Auto mode review (T46): the reviewer and how long it took. */
  readonly review?: { readonly model: string; readonly durationMs: number | undefined };
}

type AuditKind = 'permission' | 'sandbox' | 'autoReview';

const REVIEW_OUTCOMES = [
  'allow',
  'deny',
  'unsure',
  'timeout',
  'providerError',
  'unparsable',
  'invalidVerdict',
  'unavailable',
  'cancelled',
  'discarded',
] as const;

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
          const suggestion = str(r.suggestion);
          const parameter = str(r.parameter);
          const row = {
            behavior: r.behavior,
            rule,
            broad: r.broad === true,
            inactive: r.inactive === true,
            ...(suggestion === undefined ? {} : { suggestion }),
            ...(parameter === undefined ? {} : { parameter }),
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
    if (d.source === 'reviewer' && typeof d.outcome === 'string') {
      // An Auto mode review (T46): the outcome, the reviewer's reason, the model.
      return {
        at: typeof e.at === 'number' ? e.at : 0,
        sessionId: str(e.sessionId),
        tool: str(d.tool),
        step: d.outcome,
        conclusion: str(d.conclusion),
        rule: str(d.reason),
        // A subagent's review names its type (T31's audit annotation).
        ruleSource: isRecord(d.subagent) ? str(d.subagent.agentType) : undefined,
        review: {
          model: str(d.model) ?? '',
          durationMs: typeof d.durationMs === 'number' ? d.durationMs : undefined,
        },
      };
    }
    if (typeof d.denial === 'string' || d.approval === 'network') {
      // A sandbox row (T39): a refused path or host, or the answer to a network card.
      const port = typeof d.port === 'number' ? `:${String(d.port)}` : '';
      const target =
        str(d.path) ?? (str(d.host) === undefined ? undefined : `${String(d.host)}${port}`);
      return {
        at: typeof e.at === 'number' ? e.at : 0,
        sessionId: str(e.sessionId),
        tool: str(d.denial) ?? str(d.approval),
        step: str(d.operation) ?? str(d.reason) ?? str(d.decision),
        conclusion: str(d.conclusion) ?? 'deny',
        rule: target,
        ruleSource: undefined,
      };
    }
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
    case 'claudeProjectLocal':
    case 'claudeProject':
    case 'user':
    case 'claudeUser':
    case 'enterprise':
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
  const [check, setCheck] = useState<
    { error?: string; broad: boolean; parameter?: string } | undefined
  >(undefined);
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
          const parameter = str(value.parameter);
          setCheck({
            broad: value.broad === true,
            ...(error === undefined ? {} : { error }),
            ...(parameter === undefined ? {} : { parameter }),
          });
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
      <Button
        variant="primary"
        disabled={!valid}
        data-testid="permission-save"
        onClick={() => {
          onSave(text.trim(), list);
        }}
      >
        {t('permissions.save')}
      </Button>
      {onCancel && (
        <Button variant="ghost" size="small" onClick={onCancel}>
          {t('dialog.cancel')}
        </Button>
      )}
      {check?.error !== undefined && (
        <p className="error-text" role="alert" data-testid="permission-check">
          {t('permissions.invalid', { reason: check.error })}
        </p>
      )}
      {check?.error === undefined && check?.parameter !== undefined && (
        <p className="muted" data-testid="permission-parameter">
          {t('permissions.parameter', { key: check.parameter })}
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
  // T47: with `allowManagedPermissionRulesOnly` only the organization's rules apply; the
  // other files' rules stay listed (inactive) but are not edited here.
  const taken = useIsManaged('/permissions/allow');
  const writable = source.writable && !taken;
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
    <section className="permission-source" data-testid={`permission-source-${source.id}`}>
      <h3 className="permission-source-title">
        {title === undefined ? source.id : t(title)}
        {source.sessionId !== undefined && <span className="muted"> · {source.sessionId}</span>}
        {!source.writable && <span className="muted"> · {t('permissions.readOnly')}</span>}
        {(source.id === 'enterprise' || (source.writable && taken)) && (
          <ManagedBadge testId={`managed-rules-${source.id}`} />
        )}
      </h3>
      {source.file !== undefined && <div className="muted approval-path">{source.file}</div>}
      {source.rules.length === 0 && <p className="muted">{t('permissions.empty')}</p>}
      {source.rules.length > 0 && (
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
                    {r.parameter !== undefined && (
                      <span className="muted" data-testid="permission-parameter">
                        {' '}
                        {t('permissions.parameter', { key: r.parameter })}
                      </span>
                    )}
                    {r.inactive && <span className="muted"> {t('permissions.inactive')}</span>}
                    {r.suggestion !== undefined && (
                      <span className="muted" data-testid="permission-suggestion">
                        {' '}
                        {t('permissions.neverMatches', { rule: r.suggestion })}
                      </span>
                    )}
                    {writable && (
                      <span className="permission-actions">
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => {
                            setEditing(key);
                          }}
                        >
                          {t('permissions.edit')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="small"
                          onClick={() => {
                            change(r.behavior, r.rule, undefined);
                          }}
                        >
                          {t('permissions.remove')}
                        </Button>
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {writable &&
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
          <Button
            size="small"
            className="permission-add"
            data-testid={`permission-add-${source.id}`}
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('permissions.add')}
          </Button>
        ))}
    </section>
  );
}

const SINCE = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const;
type Since = keyof typeof SINCE | 'all';

/** The audit kind a link asked for (`#/settings/permissions?audit=sandbox`, T39;
 * `audit=autoReview`, T46). */
function initialKind(): AuditKind {
  const asked = /[?&]audit=(sandbox|autoReview)(?:&|$)/u.exec(window.location.hash)?.[1];
  return asked === 'sandbox' || asked === 'autoReview' ? asked : 'permission';
}

function AuditSection({ workspace }: { readonly workspace: string }) {
  const { t, format } = useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [kind, setKind] = useState<AuditKind>(initialKind);
  const [session, setSession] = useState('');
  const [tool, setTool] = useState('');
  const [conclusion, setConclusion] = useState<'' | 'allow' | 'deny'>('');
  const [since, setSince] = useState<Since>('all');
  const [error, setError] = useState('');
  const ids = {
    kind: useId(),
    session: useId(),
    tool: useId(),
    conclusion: useId(),
    since: useId(),
  };
  useEffect(() => {
    const onHash = () => {
      setKind(initialKind());
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const load = useCallback(() => {
    const query: AuditQuery = {
      workspace,
      ...(kind === 'permission' ? {} : { kind }),
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
  }, [workspace, kind, session, tool, conclusion, since]);
  useEffect(load, [load]);
  return (
    <section className="permission-audit" data-testid="permission-audit">
      <h2 className="permission-heading">{t('permissions.audit')}</h2>
      <div className="settings-audit-filters">
        <label htmlFor={ids.kind} className="settings-filter-field">
          <span>{t('permissions.audit.kind')}</span>
          <select
            id={ids.kind}
            className="input"
            value={kind}
            data-testid="audit-kind"
            onChange={(e) => {
              const value = e.currentTarget.value;
              setKind(value === 'sandbox' || value === 'autoReview' ? value : 'permission');
            }}
          >
            <option value="permission">{t('permissions.audit.kind.permission')}</option>
            <option value="sandbox">{t('permissions.audit.kind.sandbox')}</option>
            <option value="autoReview">{t('permissions.audit.kind.autoReview')}</option>
          </select>
        </label>
        <label htmlFor={ids.session} className="settings-filter-field">
          <span>{t('permissions.audit.session')}</span>
          <input
            id={ids.session}
            className="input"
            value={session}
            data-testid="audit-session"
            onChange={(e) => {
              setSession(e.target.value);
            }}
          />
        </label>
        <label htmlFor={ids.tool} className="settings-filter-field">
          <span>{t('permissions.audit.tool')}</span>
          <input
            id={ids.tool}
            className="input"
            value={tool}
            data-testid="audit-tool"
            onChange={(e) => {
              setTool(e.target.value);
            }}
          />
        </label>
        <label htmlFor={ids.conclusion} className="settings-filter-field">
          <span>{t('permissions.audit.conclusion')}</span>
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
        </label>
        <label htmlFor={ids.since} className="settings-filter-field">
          <span>{t('permissions.audit.since')}</span>
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
        </label>
        <Button size="small" onClick={load}>
          {t('permissions.audit.refresh')}
        </Button>
      </div>
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
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
              <th>
                {t(
                  kind === 'sandbox'
                    ? 'permissions.audit.target'
                    : kind === 'autoReview'
                      ? 'permissions.audit.review'
                      : 'permissions.audit.rule',
                )}
              </th>
              <th>{t('permissions.audit.conclusion')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${String(r.at)}-${String(i)}`} data-testid="audit-row">
                <td className="permission-nowrap">{format.dateTime(r.at)}</td>
                <td className="permission-nowrap" title={r.sessionId}>
                  {r.sessionId?.slice(0, 8) ?? ''}
                </td>
                <td className="permission-nowrap">
                  {kind === 'sandbox' ? sandboxKind(r.tool, r.step, t) : (r.tool ?? '')}
                </td>
                <td className="permission-nowrap">
                  {r.review === undefined ? (r.step ?? '') : outcomeLabel(r.step, t)}
                </td>
                <td>
                  {r.review === undefined ? (
                    <>
                      {r.rule === undefined ? '' : <code>{r.rule}</code>}
                      {r.ruleSource === undefined ? '' : ` · ${r.ruleSource}`}
                    </>
                  ) : (
                    <ReviewCell row={r} review={r.review} />
                  )}
                </td>
                <td className="permission-nowrap">
                  {r.conclusion === 'allow'
                    ? t('permissions.audit.allow')
                    : r.conclusion === 'deny'
                      ? t('permissions.audit.deny')
                      : r.conclusion === 'ask'
                        ? t('permissions.audit.ask')
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

/** The label of an Auto mode review's outcome (T46). */
function outcomeLabel(outcome: string | undefined, t: (id: MessageId) => string): string {
  const known = REVIEW_OUTCOMES.find((o) => o === outcome);
  return known === undefined ? (outcome ?? '') : t(`permissions.audit.outcome.${known}`);
}

/** The reviewer, its reason and its time of an Auto mode review row (T46). */
function ReviewCell({
  row,
  review,
}: {
  readonly row: AuditRow;
  readonly review: NonNullable<AuditRow['review']>;
}) {
  const { t, format } = useApp();
  return (
    <>
      <code>{review.model}</code>
      {review.durationMs === undefined
        ? ''
        : ` · ${t('permissions.audit.duration', { seconds: format.number(review.durationMs / 1000, { maximumFractionDigits: 1 }) })}`}
      {row.ruleSource === undefined ? '' : ` · ${row.ruleSource}`}
      {row.rule === undefined ? null : <div className="muted">{revealBidi(row.rule)}</div>}
    </>
  );
}

/** The label of a sandbox row's kind. */
function sandboxKind(
  denial: string | undefined,
  step: string | undefined,
  t: (id: MessageId) => string,
): string {
  if (denial === 'network' && step === undefined) return t('permissions.audit.denial.network');
  switch (denial) {
    case 'file':
      return t(
        step === 'read' ? 'permissions.audit.denial.read' : 'permissions.audit.denial.write',
      );
    case 'network':
      return t('permissions.audit.denial.network');
    default:
      return t('permissions.audit.networkApproval');
  }
}

export function PermissionsPage() {
  const { t, preferences } = useApp();
  const [view, setView] = useState<PermissionView | undefined>(undefined);
  const [error, setError] = useState('');
  const workspaceId = useId();
  const managedBypass = useIsManaged('/permissions/enableBypassPermissions');
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
    <div className="settings-section settings-detail-page" data-testid="permissions-page">
      <div className="setting">
        <span className="setting-label">
          {t('approval.modeMenu')}
          {managedBypass && <ManagedBadge testId="managed-bypass" />}
        </span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={preferences.permissions.enableBypassPermissions}
            disabled={managedBypass}
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
      <AutoReviewSection onError={report} />
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
            <WorkspaceOptions workspaces={view.workspaces} />
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
          <h2 className="permission-heading">{t('permissions.rules')}</h2>
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
