// The skills of a workspace (T37, "Skills & plugins"): where each came from, what it replaces,
// whether the model or only the user may start it, its pre-approved tools and `paths`, the
// fields PiArc ignores or does not support yet, and the files that are not valid skills. The
// output style section sets the user's default style (a folder's `/output-style` and its
// settings files come first). The extension packages (T40) are `PluginsSection`.
import { PageHeadActions } from './page-head.js';
import { ScopePicker } from './ScopePicker.js';
import { SettingsRow, SettingsSection } from './layout.js';
import { WorkspaceOptions } from './WorkspaceOptions.js';
import { SettingsInfo } from './layout.js';
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
import { reason } from '../shell/errors.js';
import { ChevronDownIcon } from '../shell/icons.js';

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
    <li className="package-row" data-testid="skill-row" data-name={skill.name}>
      <details className="package-details">
        <summary className="package-summary">
          <span className="package-text">
            <span className="package-name">
              <span className="mono-text">{skill.name}</span>
              <span className="settings-badge" data-testid="skill-source">
                {sourceLabel(t, skill.source)}
              </span>
            </span>
            {skill.description === '' ? null : (
              <span className="package-description">{skill.description}</span>
            )}
            <span className="package-meta" data-testid="skill-who">
              {who}
              {skill.argumentHint == null ? null : ` · ${skill.argumentHint}`}
            </span>
          </span>
          <span className="diagnostics-chevron">
            <ChevronDownIcon />
          </span>
        </summary>
        <div className="package-body">
          <p className="mono-text package-source">{skill.path}</p>
          <ul className="package-components">
            {(skill.allowedTools ?? []).length === 0 ? null : (
              <li data-testid="skill-allowed">
                {t('skills.allowed', { tools: (skill.allowedTools ?? []).join(', ') })}
              </li>
            )}
            {(skill.paths ?? []).length === 0 ? null : (
              <li>{t('skills.paths', { paths: (skill.paths ?? []).join(', ') })}</li>
            )}
            {skill.hooks === true ? <li>{t('skills.hooks')}</li> : null}
            {(skill.overrides ?? []).map((path) => (
              <li key={path} data-testid="skill-override">
                {t('agents.overrides', { path })}
              </li>
            ))}
          </ul>
        </div>
      </details>
      {(skill.warnings ?? []).length === 0 ? null : (
        <ul className="package-warnings" data-testid="skill-warnings">
          {(skill.warnings ?? []).map((w, index) => (
            <li key={`${w.kind}-${String(index)}`}>{warningText(t, w)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** How many skills show before "show more"; a filter appears above this many. */
const SHOWN = 10;

function SkillList({ skills }: { readonly skills: readonly SkillInfo[] }) {
  const { t } = useApp();
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(SHOWN);
  const needle = filter.trim().toLowerCase();
  const matching =
    needle === ''
      ? skills
      : skills.filter(
          (s) =>
            s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
        );
  return (
    <>
      {skills.length > SHOWN && (
        <input
          className="input diagnostics-filter"
          type="search"
          value={filter}
          aria-label={t('skills.filter')}
          placeholder={t('skills.filter')}
          data-testid="skill-filter"
          onChange={(e) => {
            setFilter(e.currentTarget.value);
            setShown(SHOWN);
          }}
        />
      )}
      <ul className="package-list" data-testid="skill-list">
        {matching.slice(0, shown).map((skill) => (
          <SkillRow key={skill.name} skill={skill} />
        ))}
      </ul>
      {matching.length > shown && (
        <button
          type="button"
          className="settings-add-link"
          data-testid="skill-more"
          onClick={() => {
            setShown((n) => n + SHOWN * 2);
          }}
        >
          {t('usage.sessions.more', { count: Math.min(SHOWN * 2, matching.length - shown) })}
        </button>
      )}
    </>
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
        setError(reason(e));
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
    <SettingsSection title={t('outputStyle.title')} testId="output-style-section">
      <SettingsRow
        label={t('skills.style.default')}
        htmlFor={selectId}
        badge={managed && <ManagedBadge testId="managed-output-style" />}
        description={
          <span data-testid="output-style-current">
            {t('skills.style.current', { name: list.style })}
          </span>
        }
      >
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
                setError(reason(failure));
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
      </SettingsRow>
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </SettingsSection>
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
        setError(reason(e));
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
        setError(t('skills.failed', { reason: reason(e) }));
      });
  }, [chosen, t]);
  useEffect(load, [load]);
  return (
    <div className="settings-detail-page" data-testid="skills-page">
      <PageHeadActions>
        <SettingsInfo text={t('skills.hint')} />
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
              data-testid="skills-workspace"
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
        <SettingsSection
          title={t('skills.title')}
          testId="skills-section"
          aside={<span className="settings-block-count">{view.skills.length}</span>}
        >
          {view.skills.length === 0 ? (
            <p className="settings-row-note package-empty">{t('skills.none')}</p>
          ) : (
            <SkillList key={chosen ?? ''} skills={view.skills} />
          )}
          {view.issues.length === 0 ? null : (
            <ul className="package-warnings" data-testid="skill-issues">
              {view.issues.map((issue) => (
                <li key={`${issue.path}:${String(issue.line ?? 0)}`}>
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
          )}
        </SettingsSection>
      )}
      <PluginsSection workspace={chosen} />
      {chosen === null ? null : <StyleSection workspace={chosen} />}
    </div>
  );
}
