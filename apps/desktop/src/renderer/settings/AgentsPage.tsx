// The subagent types of a workspace (T31): the definition files Core found and the built-in
// types, with where each came from, what it replaces, the model it resolves to, ignored and
// inactive fields, and the files that are not valid definitions (with their line).
import { PageHeadActions } from './page-head.js';
import { ScopePicker } from './ScopePicker.js';
import { SettingsInfo, SettingsSection } from './layout.js';
import type { AgentDefinition, AgentIssue, AgentSource, AgentWarning } from '@piarc/protocol';
import { WorkspaceOptions } from './WorkspaceOptions.js';
import { useCallback, useEffect, useId, useState } from 'react';

import { useApp } from '../app/app-context.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { reason } from '../shell/errors.js';

interface AgentsView {
  readonly agents: readonly AgentDefinition[];
  readonly issues: readonly AgentIssue[];
  readonly limits: { readonly maxDepth: number; readonly maxConcurrent: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's `AgentsList`, with the members this page reads checked. */
function parseAgents(text: string): AgentsView {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.agents) || !isRecord(value.limits)) {
    throw new Error('Invalid agent list');
  }
  const agents = value.agents.filter(
    (a: unknown): a is AgentDefinition =>
      isRecord(a) &&
      typeof a.name === 'string' &&
      typeof a.description === 'string' &&
      typeof a.source === 'string',
  );
  const issues = (Array.isArray(value.issues) ? value.issues : []).filter(
    (i: unknown): i is AgentIssue =>
      isRecord(i) && typeof i.path === 'string' && typeof i.message === 'string',
  );
  const { maxDepth, maxConcurrent } = value.limits;
  return {
    agents,
    issues,
    limits: {
      maxDepth: typeof maxDepth === 'number' ? maxDepth : 3,
      maxConcurrent: typeof maxConcurrent === 'number' ? maxConcurrent : 8,
    },
  };
}

/** The workspaces the diagnostics know (the open and recent ones) and the default one. */
export function parseWorkspaces(text: string): { workspace: string | null; workspaces: string[] } {
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

function warningText(
  t: (id: MessageId, values?: Record<string, string | number>) => string,
  w: AgentWarning,
): string {
  const field = w.field ?? '';
  const value = w.value ?? '';
  switch (w.kind) {
    case 'ignoredField':
      return t('subagent.warning.ignoredField', { field });
    case 'inactiveField':
      return t('subagent.warning.inactiveField', { field, task: w.task ?? '' });
    case 'projectModeIgnored':
      return t('subagent.warning.projectModeIgnored', { value });
    case 'unsupportedMode':
      return t('subagent.warning.unsupportedMode', { value });
    case 'modeClamped':
      return t('subagent.warning.modeClamped', { value });
    case 'hooksUntrusted':
      return t('subagent.warning.hooksUntrusted');
    case 'aliasFallback':
      return t('subagent.warning.aliasFallback', { value });
    case 'effortUnsupported':
      return t('subagent.warning.effortUnsupported', { value });
  }
}

/** Subagent types by where they come from, in the order a name is looked up. */
const AGENT_GROUPS: readonly {
  readonly group: 'project' | 'user' | 'plugin' | 'builtIn';
  readonly sources: readonly AgentSource[];
}[] = [
  { group: 'project', sources: ['projectPiarc', 'projectClaude'] },
  { group: 'user', sources: ['user', 'userClaude'] },
  { group: 'plugin', sources: ['plugin'] },
  { group: 'builtIn', sources: ['builtIn'] },
];

function AgentRow({
  agent,
  badge,
}: {
  readonly agent: AgentDefinition;
  /** Name the file's place (the group holds more than one). */
  readonly badge: boolean;
}) {
  const { t } = useApp();
  const model = agent.model ?? 'inherit';
  const resolved = agent.resolvedModel ?? undefined;
  const notes = [
    ...(agent.denied === true ? [t('agents.denied', { name: agent.name })] : []),
    ...(agent.overrides ?? []).map((path) => t('agents.overrides', { path })),
  ];
  return (
    <li className="settings-item" data-testid="agent-row" data-name={agent.name}>
      <div className="settings-item-body">
        <div className="settings-item-name">
          <span className="mono-text" data-tooltip={agent.path ?? undefined}>
            {agent.name}
          </span>
          {badge ? (
            <span className="settings-badge" data-testid="agent-source">
              {t(`agents.source.${agent.source}`)}
            </span>
          ) : null}
        </div>
        <div className="settings-item-detail">
          {resolved === undefined
            ? t('agents.model', { model })
            : t('agents.modelResolved', { model, target: `${resolved.provider}/${resolved.id}` })}
          {' · '}
          {agent.tools == null
            ? t('agents.allTools')
            : t('agents.tools', { tools: agent.tools.join(', ') })}
        </div>
        {notes.map((note) => (
          <div key={note} className="settings-item-note">
            {note}
          </div>
        ))}
        {(agent.warnings ?? []).length === 0 ? null : (
          <ul className="subagent-warnings" data-testid="agent-warnings">
            {(agent.warnings ?? []).map((w, index) => (
              <li key={`${w.kind}-${String(index)}`} className="settings-item-note">
                {warningText(t, w)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {agent.description === '' ? null : (
        <div className="settings-item-actions">
          <SettingsInfo text={agent.description} />
        </div>
      )}
    </li>
  );
}

export function AgentsPage() {
  const { t } = useApp();
  const selectId = useId();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<AgentsView | undefined>(undefined);
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
    setView(undefined);
    window.piarc
      .listAgents(chosen)
      .then((raw) => {
        setError('');
        setView(parseAgents(raw));
      })
      .catch((e: unknown) => {
        setError(t('agents.failed', { reason: reason(e) }));
      });
  }, [chosen, t]);
  useEffect(load, [load]);
  return (
    <div className="agents-page settings-detail-page" data-testid="agents-page">
      <PageHeadActions>
        <SettingsInfo
          text={
            view === undefined
              ? t('agents.hint')
              : `${t('agents.hint')} ${t('agents.limits', {
                  depth: view.limits.maxDepth,
                  concurrent: view.limits.maxConcurrent,
                })}`
          }
          testId="agents-limits"
        />
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
              data-testid="agents-workspace"
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
      {view === undefined ? (
        chosen === null || error !== '' ? null : (
          <p className="muted">{t('agents.loading')}</p>
        )
      ) : (
        <>
          <div className="settings-groups" data-testid="agent-list">
            {AGENT_GROUPS.map(({ group, sources }) => {
              const agents = view.agents.filter((a) => sources.includes(a.source));
              if (agents.length === 0) return null;
              return (
                <SettingsSection
                  key={group}
                  title={t(`agents.group.${group}`)}
                  testId={`agent-group-${group}`}
                  aside={<span className="settings-block-count">{agents.length}</span>}
                >
                  <ul className="agent-list">
                    {agents.map((agent) => (
                      <AgentRow key={agent.name} agent={agent} badge={sources.length > 1} />
                    ))}
                  </ul>
                </SettingsSection>
              );
            })}
          </div>
          {view.issues.length === 0 ? null : (
            <section data-testid="agent-issues">
              <h2 className="settings-heading">{t('agents.issues')}</h2>
              <ul>
                {view.issues.map((issue) => (
                  <li key={`${issue.path}:${String(issue.line ?? 0)}`} className="error-text">
                    {issue.line == null
                      ? t('agents.issueNoLine', { path: issue.path, message: issue.message })
                      : t('agents.issue', {
                          path: issue.path,
                          line: issue.line,
                          message: issue.message,
                        })}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
