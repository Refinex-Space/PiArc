// The installed view's skills, prompt templates and output styles (T37, ADR-0102). Each lists as
// rows of one shape (tile, name, one line, where it came from) and opens a page with the facts
// and warnings that would crowd a list: where its file is, who may start it, its pre-approved
// tools, what it replaces and what PiArc ignores.
import type { ResourceIssue, ResourceWarning, SkillInfo } from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { parseCommandsList, type CommandsList } from '../composer/commands-list.js';
import { sourceLabel } from '../composer/Composer.js';
import { reason } from '../shell/errors.js';
import { styleDescription } from '../shell/OutputStyleDialog.js';
import {
  CatalogEmpty,
  CatalogList,
  CatalogRow,
  DetailHead,
  InfoSection,
  type InfoItem,
} from './catalog.js';
import { ManagedBadge, useIsManaged } from './managed.js';

export interface SkillsView {
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

/** Where a skill or command came from, in a word or two (the full label is on its page). */
export function shortSource(t: Translate, source: string, plugin?: string | null): string {
  switch (source) {
    case 'projectPiarc':
    case 'projectClaude':
    case 'projectPi':
      return t('catalog.source.project');
    case 'user':
    case 'userClaude':
    case 'userPi':
      return t('catalog.source.user');
    case 'plugin':
      return plugin ?? t('catalog.source.plugin');
    case 'builtIn':
      return t('catalog.source.builtIn');
    case 'mcp':
      return t('catalog.source.mcp');
    default:
      return source;
  }
}

function matches(needle: string, ...texts: readonly string[]): boolean {
  const n = needle.trim().toLowerCase();
  return n === '' || texts.some((text) => text.toLowerCase().includes(n));
}

function whoStarts(t: Translate, skill: SkillInfo): string {
  return skill.modelInvocable
    ? skill.userInvocable
      ? t('skills.who.both')
      : t('skills.who.model')
    : skill.userInvocable
      ? t('skills.who.user')
      : t('skills.who.none');
}

export function SkillRows({
  view,
  query,
  onOpen,
}: {
  readonly view: SkillsView;
  readonly query: string;
  readonly onOpen: (name: string) => void;
}) {
  const { t } = useApp();
  const shown = view.skills.filter((s) => matches(query, s.name, s.description));
  return (
    <>
      {view.issues.length > 0 && (
        <ul className="catalog-warnings" data-testid="skill-issues">
          {view.issues.map((issue) => (
            <li key={`${issue.path}:${String(issue.line ?? 0)}`}>
              {issue.line == null
                ? t('agents.issueNoLine', { path: issue.path, message: issue.message })
                : t('agents.issue', { path: issue.path, line: issue.line, message: issue.message })}
            </li>
          ))}
        </ul>
      )}
      {view.skills.length === 0 ? (
        <CatalogEmpty testId="skill-empty">{t('skills.none')}</CatalogEmpty>
      ) : shown.length === 0 ? (
        <CatalogEmpty>{t('catalog.noMatch')}</CatalogEmpty>
      ) : (
        <CatalogList testId="skill-list">
          {shown.map((skill) => {
            const warnings = (skill.warnings ?? []).length;
            return (
              <CatalogRow
                key={skill.name}
                kind="skill"
                testId="skill-row"
                data={{ name: skill.name }}
                title={skill.name}
                note={
                  warnings > 0 ? (
                    <span
                      className="catalog-row-note is-attention"
                      data-testid="skill-warning-note"
                    >
                      {t('catalog.warnings', { count: warnings })}
                    </span>
                  ) : undefined
                }
                description={skill.description}
                openLabel={t('catalog.open', { name: skill.name })}
                onOpen={() => {
                  onOpen(skill.name);
                }}
                trailing={
                  <span className="catalog-row-meta" data-testid="skill-source">
                    {shortSource(t, skill.source, skill.plugin)}
                  </span>
                }
              />
            );
          })}
        </CatalogList>
      )}
    </>
  );
}

export function SkillDetail({
  skill,
  workspace,
}: {
  readonly skill: SkillInfo;
  readonly workspace: string;
}) {
  const { t, platform } = useApp();
  const [error, setError] = useState('');
  const about: InfoItem[] = [
    {
      label: t('catalog.about.source'),
      value: sourceLabel(t, skill.source),
      testId: 'skill-source-full',
    },
    ...(skill.plugin == null ? [] : [{ label: t('catalog.about.package'), value: skill.plugin }]),
    { label: t('catalog.about.starts'), value: whoStarts(t, skill), testId: 'skill-who' },
    ...(skill.argumentHint == null
      ? []
      : [{ label: t('catalog.about.arguments'), value: skill.argumentHint }]),
    ...((skill.allowedTools ?? []).length === 0
      ? []
      : [
          {
            label: t('catalog.about.allowed'),
            value: (skill.allowedTools ?? []).join(', '),
            testId: 'skill-allowed',
          },
        ]),
    ...((skill.paths ?? []).length === 0
      ? []
      : [{ label: t('catalog.about.paths'), value: (skill.paths ?? []).join(', ') }]),
    ...(skill.hooks === true
      ? [{ label: t('catalog.about.hooks'), value: t('skills.hooks') }]
      : []),
    ...(skill.overrides ?? []).map((path) => ({
      label: t('catalog.about.overrides'),
      value: <span className="mono-text">{path}</span>,
      testId: 'skill-override',
    })),
    {
      label: t('catalog.about.file'),
      value: <span className="mono-text">{skill.path}</span>,
    },
  ];
  return (
    <div className="catalog-detail" data-testid="skill-detail" data-name={skill.name}>
      <DetailHead
        kind="skill"
        title={skill.name}
        subtitle={sourceLabel(t, skill.source)}
        actions={
          <Button
            size="small"
            data-testid="skill-reveal"
            onClick={() => {
              setError('');
              window.piarc.revealSkill(workspace, skill.name).catch((e: unknown) => {
                setError(reason(e));
              });
            }}
          >
            {t(platform === 'win32' ? 'skills.revealWin' : 'skills.revealMac')}
          </Button>
        }
      />
      {error !== '' && (
        <p className="catalog-notice is-danger" role="alert">
          {error}
        </p>
      )}
      {skill.description !== '' && (
        <p className="catalog-detail-description">{skill.description}</p>
      )}
      {(skill.warnings ?? []).length > 0 && (
        <ul className="catalog-warnings" data-testid="skill-warnings">
          {(skill.warnings ?? []).map((w, index) => (
            <li key={`${w.kind}-${String(index)}`}>{warningText(t, w)}</li>
          ))}
        </ul>
      )}
      <InfoSection title={t('catalog.section.about')} items={about} testId="skill-about" />
    </div>
  );
}

/** A prompt template: a command file or a Pi prompt (`kind: command`). */
export interface PromptInfo {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path?: string;
  readonly plugin?: string;
  readonly argumentHint?: string;
}

/** The prompt templates of Core's commands list (command files and Pi prompts). */
export function parsePrompts(text: string): PromptInfo[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.commands)) return [];
  return value.commands.flatMap((c: unknown): PromptInfo[] => {
    if (
      !isRecord(c) ||
      c.kind !== 'command' ||
      typeof c.name !== 'string' ||
      typeof c.source !== 'string'
    ) {
      return [];
    }
    return [
      {
        name: c.name,
        description: typeof c.description === 'string' ? c.description : '',
        source: c.source,
        ...(typeof c.path === 'string' ? { path: c.path } : {}),
        ...(typeof c.plugin === 'string' ? { plugin: c.plugin } : {}),
        ...(typeof c.argumentHint === 'string' ? { argumentHint: c.argumentHint } : {}),
      },
    ];
  });
}

export function PromptRows({
  prompts,
  query,
  onOpen,
}: {
  readonly prompts: readonly PromptInfo[];
  readonly query: string;
  readonly onOpen: (name: string) => void;
}) {
  const { t } = useApp();
  const shown = prompts.filter((p) => matches(query, p.name, p.description));
  if (prompts.length === 0) {
    return <CatalogEmpty testId="prompt-empty">{t('catalog.prompts.none')}</CatalogEmpty>;
  }
  if (shown.length === 0) return <CatalogEmpty>{t('catalog.noMatch')}</CatalogEmpty>;
  return (
    <CatalogList testId="prompt-list">
      {shown.map((prompt) => (
        <CatalogRow
          key={prompt.name}
          kind="prompt"
          testId="prompt-row"
          data={{ name: prompt.name }}
          title={`/${prompt.name}`}
          note={prompt.argumentHint}
          description={prompt.description}
          openLabel={t('catalog.open', { name: prompt.name })}
          onOpen={() => {
            onOpen(prompt.name);
          }}
          trailing={
            <span className="catalog-row-meta">{shortSource(t, prompt.source, prompt.plugin)}</span>
          }
        />
      ))}
    </CatalogList>
  );
}

export function PromptDetail({ prompt }: { readonly prompt: PromptInfo }) {
  const { t } = useApp();
  const about: InfoItem[] = [
    { label: t('catalog.about.source'), value: sourceLabel(t, prompt.source) },
    ...(prompt.plugin === undefined
      ? []
      : [{ label: t('catalog.about.package'), value: prompt.plugin }]),
    ...(prompt.argumentHint === undefined
      ? []
      : [{ label: t('catalog.about.arguments'), value: prompt.argumentHint }]),
    { label: t('catalog.about.use'), value: <span className="mono-text">/{prompt.name}</span> },
    ...(prompt.path === undefined
      ? []
      : [
          {
            label: t('catalog.about.file'),
            value: <span className="mono-text">{prompt.path}</span>,
          },
        ]),
  ];
  return (
    <div className="catalog-detail" data-testid="prompt-detail" data-name={prompt.name}>
      <DetailHead
        kind="prompt"
        title={`/${prompt.name}`}
        subtitle={sourceLabel(t, prompt.source)}
      />
      {prompt.description !== '' && (
        <p className="catalog-detail-description">{prompt.description}</p>
      )}
      <InfoSection title={t('catalog.section.about')} items={about} />
    </div>
  );
}

/** Core's commands list for `workspace`: prompt templates and output styles. */
export function useCommands(workspace: string | null) {
  const [list, setList] = useState<{ prompts: PromptInfo[]; styles: CommandsList } | undefined>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (workspace === null) {
      setList(undefined);
      return;
    }
    window.piarc
      .listCommands(workspace, null)
      .then((raw) => {
        setList({ prompts: parsePrompts(raw), styles: parseCommandsList(raw) });
        setError('');
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
  }, [workspace]);
  useEffect(load, [load]);
  return { list, error, load };
}

/** The output styles: the user's default (a folder's `/output-style` and its settings come
 * first) and the styles there are, with what each does. */
export function StylesPanel({
  styles,
  onChanged,
}: {
  readonly styles: CommandsList;
  readonly onChanged: () => void;
}) {
  const { t, preferences } = useApp();
  const selectId = useId();
  const [userStyle, setUserStyle] = useState(preferences.outputStyle);
  const [error, setError] = useState('');
  const managed = useIsManaged('/outputStyle');
  return (
    <div className="catalog-detail" data-testid="output-style-section">
      <div className="catalog-style-default">
        <div className="catalog-style-default-text">
          <label htmlFor={selectId} className="catalog-row-name">
            {t('skills.style.default')}
          </label>
          {managed && <ManagedBadge testId="managed-output-style" />}
          <p className="catalog-row-description" data-testid="output-style-current">
            {t('skills.style.current', { name: styles.style })}
          </p>
        </div>
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
                setError('');
                onChanged();
              })
              .catch((failure: unknown) => {
                setError(reason(failure));
              });
          }}
        >
          <option value="">{t('skills.style.unset')}</option>
          {styles.styles.map((style) => (
            <option key={style.name} value={style.name}>
              {style.name}
            </option>
          ))}
        </select>
      </div>
      {error !== '' && (
        <p className="catalog-notice is-danger" role="alert">
          {error}
        </p>
      )}
      <CatalogList testId="style-list">
        {styles.styles.map((style) => (
          <CatalogRow
            key={style.name}
            kind="style"
            testId="style-row"
            data={{ name: style.name }}
            title={style.name}
            note={style.name === styles.style ? t('catalog.style.inUse') : undefined}
            description={styleDescription(t, style)}
            openLabel={style.name}
            trailing={<span className="catalog-row-meta">{shortSource(t, style.source)}</span>}
          />
        ))}
      </CatalogList>
    </div>
  );
}
