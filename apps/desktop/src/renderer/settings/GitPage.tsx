// Settings · Git (ADR-0085, SPEC A8): branches (prefix for new branches, protected branches),
// push and pull (pull mode, always force push), and commits (the instructions handed to the
// model when it writes a commit message). Everything is the user's own file; managed settings
// lock single values; project files have no say. Turning "always force push" on is confirmed
// natively by the main process.
import { useEffect, useId, useState } from 'react';

import {
  AUTO_FETCH_MINUTES,
  DEFAULT_PROTECTED_BRANCHES,
  GIT_LIMITS,
  isBranchPattern,
  isBranchPrefix,
  PULL_MODES,
  type PreferenceChange,
} from '../../shared/preferences.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { Button } from '../app/Button.js';
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
      <section className="settings-subsection" aria-labelledby="git-settings-branches">
        <h2 id="git-settings-branches" className="permission-heading">
          {t('gitSettings.branches')}
        </h2>
        <PrefixField value={git.branchPrefix} onSave={save} />
        <ProtectedList patterns={git.protectedBranches} onSave={save} />
      </section>
      <section className="settings-subsection" aria-labelledby="git-settings-sync">
        <h2 id="git-settings-sync" className="permission-heading">
          {t('gitSettings.sync')}
        </h2>
        <PullModeRow value={git.pullMode} onSave={save} />
        <ForcePushRow value={git.alwaysForcePush} onSave={save} />
        <AutoFetchRow value={git.autoFetch} onSave={save} />
      </section>
      <section className="settings-subsection" aria-labelledby="git-settings-commits">
        <h2 id="git-settings-commits" className="permission-heading">
          {t('gitSettings.commits')}
        </h2>
        <InstructionsField value={git.commitInstructions} language={locale} onSave={save} />
      </section>
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
              <Button
                variant="destructive"
                size="small"
                disabled={managed}
                aria-label={t('gitSettings.protectedRemove', { pattern })}
                onClick={() => {
                  onSave({
                    key: 'git.protectedBranches',
                    value: patterns.filter((p) => p !== pattern),
                  });
                }}
              >
                ×
              </Button>
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
        <label htmlFor={id} className="permission-filter-label">
          {t('gitSettings.protectedAdd')}
        </label>
        <input
          id={id}
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
  return (
    <div className="setting git-setting">
      {managed && <ManagedBadge testId="managed-git-force" />}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value}
          disabled={managed}
          data-testid="git-setting-force-push"
          onChange={(event) => {
            onSave({ key: 'git.alwaysForcePush', value: event.currentTarget.checked });
          }}
        />
        {t('gitSettings.forcePush')}
      </label>
      <p className="muted">{t('gitSettings.forcePushHint')}</p>
    </div>
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

function InstructionsField({
  value,
  language,
  onSave,
}: {
  readonly value: string;
  readonly language: string;
  readonly onSave: (change: PreferenceChange) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const managed = useIsManaged('/git/commitInstructions');
  const defaults = t('git.instructions.default');
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
        onSave({ key: 'git.commitInstructions', value: isDefault ? null : draft });
      }}
    >
      <label htmlFor={id} className="git-setting-label">
        {t('gitSettings.instructions')}
        {managed && <ManagedBadge testId="managed-git-instructions" />}
      </label>
      <p className="muted">
        {t('gitSettings.instructionsHint', {
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
        data-testid="git-setting-instructions"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <span className="git-setting-actions">
        <Button
          type="submit"
          size="small"
          disabled={managed || !changed}
          data-testid="git-setting-instructions-save"
        >
          {t('gitSettings.save')}
        </Button>
        <Button
          variant="ghost"
          size="small"
          disabled={managed || (value.trim() === '' && isDefault)}
          data-testid="git-setting-instructions-reset"
          onClick={() => {
            setDraft(defaults);
            onSave({ key: 'git.commitInstructions', value: null });
          }}
        >
          {t('gitSettings.restoreDefault')}
        </Button>
      </span>
    </form>
  );
}
