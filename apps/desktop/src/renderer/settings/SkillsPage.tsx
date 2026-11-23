// The skills of a workspace (T37, "Skills & plugins"): where each came from, what it replaces,
// whether the model or only the user may start it, its pre-approved tools and `paths`, the
// fields PiArc ignores or does not support yet, and the files that are not valid skills. The
// output style section sets the user's default style (a folder's `/output-style` and its
// settings files come first). The extension packages (T40) are `PluginsSection`.
import type { ResourceIssue, ResourceWarning, SkillInfo } from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { parseCommandsList, type CommandsList } from '../composer/commands-list.js';
import { sourceLabel } from '../composer/Composer.js';
import { styleDescription } from '../shell/OutputStyleDialog.js';
import { parseWorkspaces } from './AgentsPage.js';
import { ManagedBadge, useIsManaged } from './managed.js';
import { PluginsSection } from './PluginsSection.js';

interface SkillsView {
  readonly skills: readonly SkillInfo[];
  readonly issues: readonly ResourceIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's `SkillsList`, with the members this page reads checked. */
export function parseSkills(text: string): SkillsView {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.skills)) throw new Error('Invalid skill list');
  const skills = value.skills.filter(
    (s: unknown): s is SkillInfo =>
      isRecord(s) &&
      typeof s.name === 'string' &&
      typeof s.description === 'string' &&
      typeof s.source === 'string' &&
      typeof s.path === 'string',
  );
  const issues = (Array.isArray(value.issues) ? value.issues : []).filter(
    (i: unknown): i is ResourceIssue =>
      isRecord(i) && typeof i.path === 'string' && typeof i.message === 'string',
  );
  return { skills, issues };
}

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

export function warningText(t: Translate, w: ResourceWarning): string {
  const field = w.field ?? '';
  const value = w.value ?? '';
  switch (w.kind) {
    case 'ignoredField':
      return t('skills.warning.ignoredField', { field });
    case 'unsupportedField':
      return t('skills.warning.unsupportedField', { field, task: w.task ?? '' });
    case 'dynamicCommand':
      return t('skills.warning.dynamicCommand');
    case 'invalidFrontmatter':
      return t('skills.warning.invalidFrontmatter', { value });
    case 'invalidField':
      return t('skills.warning.invalidField', { field });
    case 'untrusted':
      return t('skills.warning.untrusted');
    case 'denied':
      return t('skills.warning.denied');
    case 'overridden':
      return t('skills.warning.overridden', { value });
  }
}

function SkillRow({ skill }: { readonly skill: SkillInfo }) {
  const { t } = useApp();
  const who = skill.modelInvocable
    ? skill.userInvocable
      ? t('skills.who.both')
      : t('skills.who.model')
    : skill.userInvocable
      ? t('skills.who.user')
      : t('skills.who.none');
  return (
    <li className="agent-row" data-testid="skill-row" data-name={skill.name}>
      <div className="agent-row-head">
        <strong>{skill.name}</strong>
        <span className="muted small" data-testid="skill-source">
          {sourceLabel(t, skill.source)}
        </span>
      </div>
      <p className="small">{skill.description}</p>
      <div className="muted small" data-testid="skill-who">
        {who}
        {skill.argumentHint == null ? null : ` · ${skill.argumentHint}`}
      </div>
      {(skill.allowedTools ?? []).length === 0 ? null : (
        <div className="muted small" data-testid="skill-allowed">
          {t('skills.allowed', { tools: (skill.allowedTools ?? []).join(', ') })}
        </div>
      )}
      {(skill.paths ?? []).length === 0 ? null : (
        <div className="muted small">
          {t('skills.paths', { paths: (skill.paths ?? []).join(', ') })}
        </div>
      )}
      {skill.hooks === true ? <div className="muted small">{t('skills.hooks')}</div> : null}
      <div className="muted small diagnostics-code">{skill.path}</div>
      {(skill.overrides ?? []).map((path) => (
        <div key={path} className="muted small" data-testid="skill-override">
          {t('agents.overrides', { path })}
        </div>
      ))}
      {(skill.warnings ?? []).length === 0 ? null : (
        <ul className="subagent-warnings" data-testid="skill-warnings">
          {(skill.warnings ?? []).map((w, index) => (
            <li key={`${w.kind}-${String(index)}`} className="muted">
              {warningText(t, w)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StyleSection({ workspace }: { readonly workspace: string }) {
  const { t, preferences } = useApp();
  const selectId = useId();
  const [list, setList] = useState<CommandsList | undefined>(undefined);
  const [error, setError] = useState('');
  const [userStyle, setUserStyle] = useState(preferences.outputStyle);
  const managed = useIsManaged('/outputStyle');
  const load = useCallback(() => {
    window.piarc
      .listCommands(workspace, null)
      .then((raw) => {
        setList(parseCommandsList(raw));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [workspace]);
  useEffect(load, [load]);
  if (list === undefined)
    return error === '' ? null : (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  return (
    <section data-testid="output-style-section">
      <h2 className="settings-heading">{t('outputStyle.title')}</h2>
      <p className="muted small" data-testid="output-style-current">
        {t('skills.style.current', { name: list.style })}
      </p>
      <label htmlFor={selectId} className="permission-filter-label">
        {t('skills.style.default')}
        {managed && <ManagedBadge testId="managed-output-style" />}
      </label>
      <select
        id={selectId}
        className="input"
        disabled={managed}
        data-testid="output-style-select"
        value={userStyle}
        onChange={(e) => {
          const name = e.currentTarget.value;
          window.piarc
            .setOutputStyle(null, name === '' ? null : name)
            .then(() => {
              setUserStyle(name);
              load();
            })
            .catch((failure: unknown) => {
              setError(failure instanceof Error ? failure.message : String(failure));
            });
        }}
      >
        <option value="">{t('skills.style.unset')}</option>
        {list.styles.map((style) => (
          <option key={style.name} value={style.name}>
            {`${style.name} — ${styleDescription(t, style)}`}
          </option>
        ))}
      </select>
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SkillsPage() {
  const { t } = useApp();
  const selectId = useId();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<SkillsView | undefined>(undefined);
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
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);
  const load = useCallback(() => {
    if (chosen === null) return;
    setView(undefined);
    window.piarc
      .listSkills(chosen)
      .then((raw) => {
        setError('');
        setView(parseSkills(raw));
      })
      .catch((e: unknown) => {
        setError(t('skills.failed', { reason: e instanceof Error ? e.message : String(e) }));
      });
  }, [chosen, t]);
  useEffect(load, [load]);
  return (
    <div className="agents-page" data-testid="skills-page">
      <p className="muted">{t('skills.hint')}</p>
      {chosen === null ? (
        <p className="muted">{t('agents.noWorkspace')}</p>
      ) : (
        <div className="permission-filters">
          <label htmlFor={selectId} className="permission-filter-label">
            {t('permissions.workspace')}
          </label>
          <select
            id={selectId}
            className="input"
            value={chosen}
            data-testid="skills-workspace"
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
      {chosen === null ? null : <StyleSection workspace={chosen} />}
      <PluginsSection workspace={chosen} />
      {view === undefined ? null : (
        <>
          <h2 className="settings-heading">{t('skills.title')}</h2>
          {view.skills.length === 0 ? <p className="muted">{t('skills.none')}</p> : null}
          <ul className="agent-list" data-testid="skill-list">
            {view.skills.map((skill) => (
              <SkillRow key={skill.name} skill={skill} />
            ))}
          </ul>
          {view.issues.length === 0 ? null : (
            <section data-testid="skill-issues">
              <h2 className="settings-heading">{t('skills.issues')}</h2>
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
