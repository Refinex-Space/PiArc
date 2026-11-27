// Settings · Git (ADR-0085, SPEC A8, design addendum P5): branches (prefix for new branches,
// protected branches), push and pull (pull mode, always force push, automatic fetch), commits
// (the instructions handed to the model when it writes a commit message), pull requests (merge
// method, drafts, the instructions for descriptions) and code review (how findings show). Everything is the user's own file; managed settings
// lock single values; project files have no say. Turning "always force push" on is confirmed
// natively by the main process.
import { useEffect, useId, useState } from 'react';

import {
  AUTO_FETCH_MINUTES,
  DEFAULT_PROTECTED_BRANCHES,
  GIT_LIMITS,
  isBranchPattern,
  isBranchPrefix,
  MERGE_METHODS,
  PULL_MODES,
  REVIEW_PRESENTATIONS,
  type PreferenceChange,
} from '../../shared/preferences.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon } from '../shell/icons.js';
import { SettingsRow, SettingsSection } from './layout.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { ManagedBadge, useIsManaged } from './managed.js';

export function GitPage() {
  const { t, preferences, locale } = useApp();
  const git = preferences.git;
  const [error, setError] = useState<string>();
  const save = (change: PreferenceChange) => {
    setError(undefined);
    window.piarc.setPreference(change).catch((failure: unknown) => {
      setError(t('settings.saveFailed', { reason: reason(failure) }));
    });
  };
  return (
    <div className="git-settings" data-testid="git-settings">
      {error === undefined ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <SettingsSection title={t('gitSettings.branches')} id="git-settings-branches">
        <PrefixField value={git.branchPrefix} onSave={save} />
        <ProtectedList patterns={git.protectedBranches} onSave={save} />
      </SettingsSection>
      <SettingsSection title={t('gitSettings.sync')} id="git-settings-sync">
        <PullModeRow value={git.pullMode} onSave={save} />
        <ForcePushRow value={git.alwaysForcePush} onSave={save} />
        <AutoFetchRow value={git.autoFetch} onSave={save} />
      </SettingsSection>
      <SettingsSection title={t('gitSettings.commits')} id="git-settings-commits">
        <InstructionsField
          kind="commit"
          value={git.commitInstructions}
          language={locale}
          onSave={save}
        />
      </SettingsSection>
      <SettingsSection title={t('gitSettings.pullRequests')} id="git-settings-prs">
        <MergeMethodRow value={git.mergeMethod} onSave={save} />
        <DraftRow value={git.draftPullRequests} onSave={save} />
        <InstructionsField kind="pr" value={git.prInstructions} language={locale} onSave={save} />
      </SettingsSection>
      <SettingsSection title={t('gitSettings.review')} id="git-settings-review">
        <ReviewPresentationRow value={git.reviewPresentation} onSave={save} />
      </SettingsSection>
    </div>
  );
}

function PrefixField({
  value,
  onSave,
}: {
  readonly value: string;
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const hintId = useId();
  const managed = useIsManaged('/git/branchPrefix');
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const valid = isBranchPrefix(draft);
  return (
    <form
      className="setting git-setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && draft !== value) onSave({ key: 'git.branchPrefix', value: draft });
      }}
    >
      <label htmlFor={id} className="git-setting-label">
        {t('gitSettings.prefix')}
        {managed && <ManagedBadge testId="managed-git-prefix" />}
      </label>
      <span className="git-setting-field">
        <input
          id={id}
          className="input"
          value={draft}
          maxLength={GIT_LIMITS.prefix}
          placeholder={t('gitSettings.prefixPlaceholder')}
          spellCheck={false}
          disabled={managed}
          aria-invalid={!valid}
          aria-describedby={hintId}
          data-testid="git-setting-prefix"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          type="submit"
          size="small"
          disabled={managed || !valid || draft === value}
          data-testid="git-setting-prefix-save"
        >
          {t('gitSettings.save')}
        </Button>
      </span>
      <p id={hintId} className={valid ? 'muted' : 'error-text'}>
        {t(valid ? 'gitSettings.prefixHint' : 'gitSettings.prefixInvalid')}
      </p>
    </form>
  );
}

function ProtectedList({
  patterns,
  onSave,
}: {
  readonly patterns: readonly string[];
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const managed = useIsManaged('/git/protectedBranches');
  const [draft, setDraft] = useState('');
  const value = draft.trim();
  const isDefault =
    patterns.length === DEFAULT_PROTECTED_BRANCHES.length &&
    patterns.every((p, i) => p === DEFAULT_PROTECTED_BRANCHES[i]);
  const full = patterns.length >= GIT_LIMITS.patterns;
  return (
    <div className="setting git-setting" data-testid="git-setting-protected">
      <span className="git-setting-label">
        {t('gitSettings.protected')}
        {managed && <ManagedBadge testId="managed-git-protected" />}
      </span>
      <p className="muted">{t('gitSettings.protectedHint')}</p>
      <ul className="permission-rules">
        {patterns.map((pattern) => (
          <li key={pattern} className="permission-rule" data-testid="git-setting-protected-entry">
            <code>{pattern}</code>
            <span className="permission-actions">
              <IconButton
                size="xs"
                className="settings-remove"
                disabled={managed}
                label={t('gitSettings.protectedRemove', { pattern })}
                onClick={() => {
                  onSave({
                    key: 'git.protectedBranches',
                    value: patterns.filter((p) => p !== pattern),
                  });
                }}
              >
                <CloseIcon />
              </IconButton>
            </span>
          </li>
        ))}
        {patterns.length === 0 ? <li className="muted">{t('gitSettings.protectedNone')}</li> : null}
      </ul>
      <form
        className="permission-editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isBranchPattern(value) || patterns.includes(value) || full) return;
          onSave({ key: 'git.protectedBranches', value: [...patterns, value] });
          setDraft('');
        }}
      >
        <input
          id={id}
          aria-label={t('gitSettings.protectedAdd')}
          className="input"
          value={draft}
          disabled={managed || full}
          placeholder={t('gitSettings.protectedPlaceholder')}
          spellCheck={false}
          data-testid="git-setting-protected-input"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          type="submit"
          size="small"
          disabled={managed || full || !isBranchPattern(value) || patterns.includes(value)}
        >
          {t('gitSettings.add')}
        </Button>
        {isDefault ? null : (
          <Button
            variant="ghost"
            size="small"
            disabled={managed}
            data-testid="git-setting-protected-reset"
            onClick={() => {
              onSave({ key: 'git.protectedBranches', value: null });
            }}
          >
            {t('gitSettings.restoreDefault')}
          </Button>
        )}
      </form>
    </div>
  );
}

function PullModeRow({
  value,
  onSave,
}: {
  readonly value: (typeof PULL_MODES)[number];
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const labelId = useId();
  const managed = useIsManaged('/git/pullMode');
  return (
    <div className="setting git-setting">
      <span id={labelId} className="git-setting-label">
        {t('gitSettings.pullMode')}
        {managed && <ManagedBadge testId="managed-git-pull" />}
      </span>
      <SegmentedControl
        options={PULL_MODES}
        value={value}
        disabled={managed}
        name="git-pull-mode"
        testIdPrefix="git-setting-pull"
        aria-labelledby={labelId}
        onChange={(mode) => {
          onSave({ key: 'git.pullMode', value: mode });
        }}
        labelOf={(mode) => t(`git.pullMode.${mode}`)}
      />
      <p className="muted">{t(`git.pullMode.${value}Hint`)}</p>
    </div>
  );
}

function ForcePushRow({
  value,
  onSave,
}: {
  readonly value: boolean;
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const managed = useIsManaged('/git/alwaysForcePush');
  const id = useId();
  return (
    <SettingsRow
      label={t('gitSettings.forcePush')}
      description={t('gitSettings.forcePushHint')}
      htmlFor={id}
      badge={managed && <ManagedBadge testId="managed-git-force" />}
    >
      <input
        id={id}
        type="checkbox"
        className="preference-switch"
        checked={value}
        disabled={managed}
        data-testid="git-setting-force-push"
        onChange={(event) => {
          onSave({ key: 'git.alwaysForcePush', value: event.currentTarget.checked });
        }}
      />
    </SettingsRow>
  );
}

const AUTO_FETCH_LABELS = {
  0: 'gitSettings.autoFetch.0',
  5: 'gitSettings.autoFetch.5',
  15: 'gitSettings.autoFetch.15',
  30: 'gitSettings.autoFetch.30',
  60: 'gitSettings.autoFetch.60',
} as const satisfies Record<(typeof AUTO_FETCH_MINUTES)[number], MessageId>;

function AutoFetchRow({
  value,
  onSave,
}: {
  readonly value: (typeof AUTO_FETCH_MINUTES)[number];
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const selectId = useId();
  const managed = useIsManaged('/git/autoFetch');
  return (
    <div className="setting git-setting">
      <label htmlFor={selectId} className="git-setting-label">
        {t('gitSettings.autoFetch')}
        {managed && <ManagedBadge testId="managed-git-auto-fetch" />}
      </label>
      <select
        id={selectId}
        className="input git-setting-select"
        value={String(value)}
        disabled={managed}
        data-testid="git-setting-auto-fetch"
        onChange={(event) => {
          const minutes = AUTO_FETCH_MINUTES.find((m) => String(m) === event.currentTarget.value);
          if (minutes !== undefined) onSave({ key: 'git.autoFetch', value: minutes });
        }}
      >
        {AUTO_FETCH_MINUTES.map((minutes) => (
          <option key={minutes} value={String(minutes)}>
            {t(AUTO_FETCH_LABELS[minutes])}
          </option>
        ))}
      </select>
      <p className="muted">{t('gitSettings.autoFetchHint')}</p>
    </div>
  );
}

/** The two instruction fields: commit messages, and pull request descriptions (G5). */
const INSTRUCTIONS = {
  commit: {
    key: 'git.commitInstructions',
    pointer: '/git/commitInstructions',
    label: 'gitSettings.instructions',
    hint: 'gitSettings.instructionsHint',
    defaults: 'git.instructions.default',
    testId: 'git-setting-instructions',
  },
  pr: {
    key: 'git.prInstructions',
    pointer: '/git/prInstructions',
    label: 'gitSettings.prInstructions',
    hint: 'gitSettings.prInstructionsHint',
    defaults: 'git.instructions.prDefault',
    testId: 'git-setting-pr-instructions',
  },
} as const;

function InstructionsField({
  kind,
  value,
  language,
  onSave,
}: {
  readonly kind: keyof typeof INSTRUCTIONS;
  readonly value: string;
  readonly language: string;
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const field = INSTRUCTIONS[kind];
  const managed = useIsManaged(field.pointer);
  const defaults = t(field.defaults);
  const shown = value.trim() === '' ? defaults : value;
  const [draft, setDraft] = useState(shown);
  useEffect(() => {
    setDraft(shown);
  }, [shown]);
  const changed = draft !== shown;
  const isDefault = draft.trim() === defaults.trim();
  return (
    <form
      className="setting git-setting"
      onSubmit={(event) => {
        event.preventDefault();
        // The default text is not written: it follows the interface language.
        onSave({ key: field.key, value: isDefault ? null : draft });
      }}
    >
      <label htmlFor={id} className="git-setting-label">
        {t(field.label)}
        {managed && <ManagedBadge testId={`managed-${field.testId}`} />}
      </label>
      <p className="muted">
        {t(field.hint, {
          language: t(language === 'zh-CN' ? 'gitSettings.language.zh' : 'gitSettings.language.en'),
        })}
      </p>
      <textarea
        id={id}
        className="input git-instructions"
        rows={10}
        value={draft}
        maxLength={GIT_LIMITS.instructions}
        disabled={managed}
        spellCheck={false}
        data-testid={field.testId}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <span className="git-setting-actions">
        <Button
          type="submit"
          size="small"
          disabled={managed || !changed}
          data-testid={`${field.testId}-save`}
        >
          {t('gitSettings.save')}
        </Button>
        <Button
          variant="ghost"
          size="small"
          disabled={managed || (value.trim() === '' && isDefault)}
          data-testid={`${field.testId}-reset`}
          onClick={() => {
            setDraft(defaults);
            onSave({ key: field.key, value: null });
          }}
        >
          {t('gitSettings.restoreDefault')}
        </Button>
      </span>
    </form>
  );
}

function MergeMethodRow({
  value,
  onSave,
}: {
  readonly value: (typeof MERGE_METHODS)[number];
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const labelId = useId();
  const managed = useIsManaged('/git/mergeMethod');
  return (
    <div className="setting git-setting">
      <span id={labelId} className="git-setting-label">
        {t('gitSettings.mergeMethod')}
        {managed && <ManagedBadge testId="managed-git-merge-method" />}
      </span>
      <SegmentedControl
        options={MERGE_METHODS}
        value={value}
        disabled={managed}
        name="git-merge-method"
        testIdPrefix="git-setting-merge"
        aria-labelledby={labelId}
        onChange={(method) => {
          onSave({ key: 'git.mergeMethod', value: method });
        }}
        labelOf={(method) => t(`git.pr.method.${method}`)}
      />
      <p className="muted">{t('gitSettings.mergeMethodHint')}</p>
    </div>
  );
}

function DraftRow({
  value,
  onSave,
}: {
  readonly value: boolean;
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const managed = useIsManaged('/git/draftPullRequests');
  const id = useId();
  return (
    <SettingsRow
      label={t('gitSettings.draft')}
      htmlFor={id}
      badge={managed && <ManagedBadge testId="managed-git-draft" />}
    >
      <input
        id={id}
        type="checkbox"
        className="preference-switch"
        checked={value}
        disabled={managed}
        data-testid="git-setting-draft"
        onChange={(event) => {
          onSave({ key: 'git.draftPullRequests', value: event.currentTarget.checked });
        }}
      />
    </SettingsRow>
  );
}

function ReviewPresentationRow({
  value,
  onSave,
}: {
  readonly value: (typeof REVIEW_PRESENTATIONS)[number];
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const labelId = useId();
  const managed = useIsManaged('/git/reviewPresentation');
  return (
    <div className="setting git-setting">
      <span id={labelId} className="git-setting-label">
        {t('gitSettings.reviewPresentation')}
        {managed && <ManagedBadge testId="managed-git-review" />}
      </span>
      <SegmentedControl
        options={REVIEW_PRESENTATIONS}
        value={value}
        disabled={managed}
        name="git-review-presentation"
        testIdPrefix="git-setting-review"
        aria-labelledby={labelId}
        onChange={(presentation) => {
          onSave({ key: 'git.reviewPresentation', value: presentation });
        }}
        labelOf={(presentation) => t(`gitSettings.reviewPresentation.${presentation}`)}
      />
      <p className="muted">{t(`gitSettings.reviewPresentationHint.${value}`)}</p>
    </div>
  );
}
