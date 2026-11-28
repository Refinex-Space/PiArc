// The "Auto review" part of the permission settings (T46, design addendum section 7.1): the
// reviewer model (only models that meet the reviewer bar), the switch (the main process asks
// for a native confirmation before it turns on, and only with a reviewer chosen), and the four
// lists of the user's review policy. Everything here is the user's own PiArc settings file;
// entries of Claude Code's user settings apply too and are listed read-only.
import { useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import {
  AUTO_MODE_ENTRY_CHARS,
  AUTO_MODE_LISTS,
  type AutoModeList,
} from '../../shared/preferences.js';
import { useApp } from '../app/app-context.js';
import { ManagedBadge, useIsManaged } from './managed.js';
import { parseDiagnostics } from './ConfigDiagnosticsPage.js';
import { parseSettings, type CatalogEntry } from './provider-form.js';
import { Button } from '../app/Button.js';
import { SettingsInfo, SettingsRow, SettingsSection } from './layout.js';

const LIST_LABEL: Readonly<Record<AutoModeList, MessageId>> = {
  environment: 'permissions.auto.list.environment',
  allow: 'permissions.auto.list.allow',
  soft_deny: 'permissions.auto.list.softDeny',
  hard_deny: 'permissions.auto.list.hardDeny',
};

const LIST_HINT: Readonly<Record<AutoModeList, MessageId>> = {
  environment: 'permissions.auto.hint.environment',
  allow: 'permissions.auto.hint.allow',
  soft_deny: 'permissions.auto.hint.softDeny',
  hard_deny: 'permissions.auto.hint.hardDeny',
};

/** Entries of `~/.claude/settings.json`'s `autoMode` lists, from Core's diagnostics. */
function claudeEntries(raw: string): Record<AutoModeList, string[]> {
  const out: Record<AutoModeList, string[]> = {
    environment: [],
    allow: [],
    soft_deny: [],
    hard_deny: [],
  };
  const file = parseDiagnostics(raw).files.find((f) => f.layer === 'claudeUser');
  for (const row of file?.effective ?? []) {
    const list = AUTO_MODE_LISTS.find((name) => row.pointer === `/autoMode/${name}`);
    if (list === undefined || !Array.isArray(row.value)) continue;
    out[list] = row.value.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== '$defaults',
    );
  }
  return out;
}

export function AutoReviewSection({ onError }: { readonly onError: (e: unknown) => void }) {
  const { t, preferences } = useApp();
  const auto = preferences.autoMode;
  const enabled = preferences.permissions.enableAutoMode;
  const [models, setModels] = useState<CatalogEntry[] | undefined>(undefined);
  const [claude, setClaude] = useState<Record<AutoModeList, string[]> | undefined>(undefined);
  const modelId = useId();
  const switchId = useId();
  useEffect(() => {
    window.piarc
      .providerSettings()
      .then((raw) => {
        setModels(parseSettings(raw).catalogModels.filter((m) => m.reviewer === true));
      })
      .catch(onError);
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        setClaude(claudeEntries(raw));
      })
      .catch(onError);
  }, []);
  const choices = models ?? [];
  // T47: the organization may manage the switch (or turn the mode off) and the reviewer.
  const managedSwitch =
    useIsManaged('/permissions/enableAutoMode') || useIsManaged('/disableAutoMode');
  const managedModel = useIsManaged('/autoMode/model');
  const chosenKnown = choices.some((m) => `${m.provider}/${m.id}` === auto.model);
  return (
    <SettingsSection
      title={t('permissions.auto.title')}
      testId="auto-review-section"
      aside={<SettingsInfo text={t('permissions.auto.intro')} />}
    >
      <SettingsRow
        label={t('permissions.auto.model')}
        htmlFor={modelId}
        badge={managedModel && <ManagedBadge testId="managed-auto-model" />}
        description={
          models !== undefined && choices.length === 0 ? (
            <span data-testid="auto-review-no-models">{t('permissions.auto.noReviewer')}</span>
          ) : undefined
        }
      >
        <select
          id={modelId}
          className="input"
          value={auto.model}
          disabled={managedModel}
          data-testid="auto-review-model"
          onChange={(e) => {
            const value = e.currentTarget.value;
            window.piarc
              .setPreference({ key: 'autoMode.model', value: value === '' ? null : value })
              .catch(onError);
          }}
        >
          <option value="">{t('permissions.auto.modelNone')}</option>
          {auto.model !== '' && !chosenKnown && (
            <option value={auto.model}>
              {t('permissions.auto.modelUnavailable', { model: auto.model })}
            </option>
          )}
          {choices.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.name} ({m.provider})
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow
        label={t('permissions.auto.enableToggle')}
        htmlFor={switchId}
        badge={managedSwitch && <ManagedBadge testId="managed-auto-switch" />}
        description={t(
          auto.model === '' && !enabled ? 'permissions.auto.needModel' : 'permissions.auto.hint',
        )}
      >
        <input
          id={switchId}
          type="checkbox"
          className="preference-switch"
          checked={enabled}
          disabled={managedSwitch || (!enabled && auto.model === '')}
          data-testid="setting-enable-auto"
          onChange={(event) => {
            window.piarc
              .setPreference({
                key: 'permissions.enableAutoMode',
                value: event.currentTarget.checked,
              })
              .catch(onError);
          }}
        />
      </SettingsRow>
      {AUTO_MODE_LISTS.map((list) => (
        <PolicyList
          key={list}
          list={list}
          entries={auto.lists[list]}
          claude={claude?.[list] ?? []}
          onError={onError}
        />
      ))}
    </SettingsSection>
  );
}

function PolicyList({
  list,
  entries,
  claude,
  onError,
}: {
  readonly list: AutoModeList;
  readonly entries: readonly string[];
  readonly claude: readonly string[];
  readonly onError: (e: unknown) => void;
}) {
  const { t } = useApp();
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const managed = useIsManaged(`/autoMode/${list}`);
  const save = (next: readonly string[]) => {
    window.piarc.setPreference({ key: 'autoMode.list', list, value: next }).catch(onError);
  };
  const entry = draft.trim();
  return (
    <SettingsRow
      wide
      testId={`auto-review-list-${list}`}
      label={t(LIST_LABEL[list])}
      htmlFor={inputId}
      badge={managed && <ManagedBadge testId={`managed-auto-list-${list}`} />}
      description={t(LIST_HINT[list])}
    >
      <ul className="auto-review-entries">
        {entries.map((value, index) => (
          <li key={`${String(index)}:${value}`}>
            <span className="auto-review-entry">{value}</span>{' '}
            <Button
              variant="destructive"
              size="small"
              disabled={managed}
              aria-label={t('permissions.auto.remove', { value })}
              onClick={() => {
                save(entries.filter((_, i) => i !== index));
              }}
            >
              {t('permissions.auto.removeShort')}
            </Button>
          </li>
        ))}
        {claude.map((value) => (
          <li key={`claude:${value}`} className="muted" data-testid="auto-review-claude-entry">
            <span className="auto-review-entry">{value}</span>{' '}
            <span className="tag">{t('permissions.auto.fromClaude')}</span>
          </li>
        ))}
      </ul>
      <form
        className="auto-review-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (entry === '' || entries.includes(entry)) return;
          save([...entries, entry]);
          setDraft('');
        }}
      >
        <input
          id={inputId}
          className="input"
          value={draft}
          maxLength={AUTO_MODE_ENTRY_CHARS}
          disabled={managed}
          placeholder={t('permissions.auto.addPlaceholder')}
          data-testid={`auto-review-input-${list}`}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
          }}
        />
        <Button type="submit" size="small" disabled={managed || entry === ''}>
          {t('permissions.auto.add')}
        </Button>
      </form>
    </SettingsRow>
  );
}
