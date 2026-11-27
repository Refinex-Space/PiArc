// Per-model settings and the auxiliary model in the settings window (T29, architecture section
// 8.2): display name, context window, image input, default effort and Tool Profile replace the
// catalog's values; Core saves them in the user's settings and sends them to every Agent Host.
import { useId, useState, type ReactNode } from 'react';

import { useApp, useT } from '../app/app-context.js';
import type { MessageId } from '../../shared/i18n/index.js';
import {
  MODEL_ALIASES,
  type CatalogEntry,
  type ModelOverride,
  type ProviderSettings,
} from './provider-form.js';
import { Button } from '../app/Button.js';
import { SettingsInfo, SettingsRow, SettingsSection } from './layout.js';

const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

const EFFORT_LABELS: Record<string, MessageId> = {
  off: 'models.effort.off',
  low: 'models.effort.low',
  medium: 'models.effort.medium',
  high: 'models.effort.high',
  xhigh: 'models.effort.xhigh',
  max: 'models.effort.max',
};

const RELIABILITY_LABELS: Record<string, MessageId> = {
  verified: 'models.settings.reliabilityVerified',
  unknown: 'models.settings.reliabilityUnknown',
  low: 'models.settings.reliabilityLow',
};

interface Draft {
  displayName: string;
  contextWindow: string;
  vision: '' | 'on' | 'off';
  serverContextEdit?: '' | 'clearTools' | 'compact';
  nativeWebSearch: '' | 'on' | 'off';
  defaultEffort: string;
  toolProfile: '' | 'default' | 'conservative';
}

function draftOf(o: ModelOverride | undefined): Draft {
  return {
    serverContextEdit: o?.serverContextEdit ?? '',
    displayName: o?.displayName ?? '',
    contextWindow: o?.contextWindow === undefined ? '' : String(o.contextWindow),
    vision: o?.vision === undefined ? '' : o.vision ? 'on' : 'off',
    nativeWebSearch: o?.nativeWebSearch === undefined ? '' : o.nativeWebSearch ? 'on' : 'off',
    defaultEffort: o?.defaultEffort ?? '',
    toolProfile: o?.toolProfile ?? '',
  };
}

/** The override a draft stands for, or a message id when the window is invalid. */
export function overrideOf(draft: Draft): ModelOverride | MessageId {
  const out: ModelOverride = {};
  if (draft.serverContextEdit) out.serverContextEdit = draft.serverContextEdit;
  const name = draft.displayName.trim();
  if (name !== '') out.displayName = name;
  if (draft.contextWindow.trim() !== '') {
    const window = Number(draft.contextWindow.replaceAll(',', '').trim());
    if (!Number.isSafeInteger(window) || window < 1024 || window > 10_000_000) {
      return 'models.settings.invalidWindow';
    }
    out.contextWindow = window;
  }
  if (draft.vision !== '') out.vision = draft.vision === 'on';
  if (draft.nativeWebSearch !== '') out.nativeWebSearch = draft.nativeWebSearch === 'on';
  if (draft.defaultEffort !== '') out.defaultEffort = draft.defaultEffort;
  if (draft.toolProfile !== '') out.toolProfile = draft.toolProfile;
  return out;
}

function ModelForm({
  model,
  current,
  busy,
  onSave,
  onCancel,
}: {
  readonly model: CatalogEntry;
  readonly current: ModelOverride | undefined;
  readonly busy: boolean;
  readonly onSave: (override: ModelOverride) => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  const base = useId();
  const [draft, setDraft] = useState(() => draftOf(current));
  const unavailableEdit =
    current?.serverContextEdit !== undefined &&
    !model.serverContextEdits?.includes(current.serverContextEdit)
      ? current.serverContextEdit
      : undefined;
  const [invalid, setInvalid] = useState<MessageId>();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
    setInvalid(undefined);
  };
  const id = (name: string) => `${base}-${name}`;
  const label = RELIABILITY_LABELS[model.toolReliability];
  const reliabilityText = label === undefined ? model.toolReliability : t(label);
  return (
    <form
      className="settings-section model-form"
      data-testid={`model-form-${keyOf(model)}`}
      onSubmit={(event) => {
        event.preventDefault();
        const result = overrideOf(draft);
        if (typeof result === 'string') {
          setInvalid(result);
          return;
        }
        onSave(result);
      }}
    >
      <fieldset className="settings-section provider-form" disabled={busy}>
        <div className="setting">
          <label className="setting-label" htmlFor={id('name')}>
            {t('models.settings.displayName')}
          </label>
          <input
            id={id('name')}
            className="input"
            data-testid="model-display-name"
            placeholder={model.name}
            value={draft.displayName}
            onChange={(e) => {
              set('displayName', e.currentTarget.value);
            }}
          />
        </div>
        <div className="setting">
          <label className="setting-label" htmlFor={id('window')}>
            {t('models.settings.contextWindow')}
          </label>
          <input
            id={id('window')}
            className="input"
            inputMode="numeric"
            data-testid="model-context-window"
            placeholder={String(model.contextWindow)}
            aria-invalid={invalid !== undefined}
            value={draft.contextWindow}
            onChange={(e) => {
              set('contextWindow', e.currentTarget.value);
            }}
          />
          {invalid === undefined ? null : (
            <span className="error-text small" role="alert">
              {t(invalid)}
            </span>
          )}
        </div>
        <div className="setting">
          <label className="setting-label" htmlFor={id('vision')}>
            {t('models.settings.vision')}
          </label>
          <select
            id={id('vision')}
            className="input"
            data-testid="model-vision"
            value={draft.vision}
            onChange={(e) => {
              set('vision', e.currentTarget.value as Draft['vision']);
            }}
          >
            <option value="">
              {t('models.settings.catalog', {
                value: t(model.vision ? 'models.settings.on' : 'models.settings.off'),
              })}
            </option>
            <option value="on">{t('models.settings.on')}</option>
            <option value="off">{t('models.settings.off')}</option>
          </select>
        </div>
        <div className="setting">
          <label className="setting-label" htmlFor={id('search')}>
            {t('models.settings.nativeWebSearch')}
          </label>
          <select
            id={id('search')}
            className="input"
            data-testid="model-native-search"
            value={draft.nativeWebSearch}
            onChange={(e) => {
              set('nativeWebSearch', e.currentTarget.value as Draft['nativeWebSearch']);
            }}
          >
            <option value="">
              {t('models.settings.catalog', {
                value: t(
                  model.nativeWebSearch === true ? 'models.settings.on' : 'models.settings.off',
                ),
              })}
            </option>
            <option value="on">{t('models.settings.on')}</option>
            <option value="off">{t('models.settings.off')}</option>
          </select>
        </div>
        {((model.serverContextEdits?.length ?? 0) > 0 ||
          current?.serverContextEdit !== undefined) && (
          <div className="setting">
            <label className="setting-label" htmlFor={id('compaction')}>
              {t('models.settings.compaction')}
            </label>
            <select
              className="input"
              id={id('compaction')}
              value={draft.serverContextEdit ?? ''}
              onChange={(event) => {
                set('serverContextEdit', event.currentTarget.value as Draft['serverContextEdit']);
              }}
            >
              <option value="">{t('models.settings.clientCompact')}</option>
              {unavailableEdit !== undefined && (
                <option value={unavailableEdit} disabled>
                  {t('models.settings.serverUnavailable')}
                </option>
              )}
              {model.serverContextEdits?.map((edit) => (
                <option key={edit} value={edit}>
                  {t(
                    edit === 'clearTools'
                      ? 'models.settings.clearTools'
                      : 'models.settings.serverCompact',
                  )}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="setting">
          <label className="setting-label" htmlFor={id('effort')}>
            {t('models.settings.effort')}
          </label>
          <select
            id={id('effort')}
            className="input"
            data-testid="model-default-effort"
            value={draft.defaultEffort}
            onChange={(e) => {
              set('defaultEffort', e.currentTarget.value);
            }}
          >
            <option value="">{t('models.default')}</option>
            {model.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_LABELS[effort] === undefined ? effort : t(EFFORT_LABELS[effort])}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <label className="setting-label" htmlFor={id('profile')}>
            {t('models.settings.profile')}
          </label>
          <select
            id={id('profile')}
            className="input"
            data-testid="model-tool-profile"
            value={draft.toolProfile}
            onChange={(e) => {
              set('toolProfile', e.currentTarget.value as Draft['toolProfile']);
            }}
          >
            <option value="">
              {t('models.settings.profileAuto', { reliability: reliabilityText })}
            </option>
            <option value="default">{t('models.settings.profileDefault')}</option>
            <option value="conservative">{t('models.settings.profileConservative')}</option>
          </select>
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" size="small" onClick={onCancel}>
            {t('dialog.cancel')}
          </Button>
          <Button type="submit" variant="primary" data-testid="model-save">
            {t('models.settings.save')}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

/** The auxiliary model and the per-model settings. */
export function ModelSettingsSection({
  catalogRow,
  settings,
  busy,
  save,
}: {
  /** The catalog's own setting (refresh online), first in the section. */
  readonly catalogRow?: ReactNode;
  readonly settings: ProviderSettings;
  readonly busy: boolean;
  /** Saves the preferences (`setModelPreferences`). */
  readonly save: (preferencesJson: string) => void;
}) {
  const { t, format } = useApp();
  const auxId = useId();
  const [editing, setEditing] = useState<string>();
  // Every save sends the whole preferences, the alias table included (T31).
  const preferences = (
    models: Record<string, ModelOverride>,
    auxiliary: ProviderSettings['auxiliary'],
    auxiliaryAlias: string | null = settings.auxiliaryAlias,
  ) =>
    JSON.stringify({
      models,
      ...(auxiliaryAlias === null ? (auxiliary === null ? {} : { auxiliary }) : { auxiliaryAlias }),
      aliases: settings.aliases,
    });
  const models = settings.catalogModels;
  const chosen = models.find((m) => editing === keyOf(m));
  return (
    <SettingsSection
      title={t('models.settings.title')}
      testId="model-settings-section"
      aside={<SettingsInfo text={t('models.settings.hint')} />}
    >
      {catalogRow}
      <SettingsRow
        label={t('models.auxiliary')}
        htmlFor={auxId}
        description={t('models.auxiliary.hint')}
      >
        <select
          id={auxId}
          className="input"
          data-testid="auxiliary-model"
          disabled={busy}
          value={
            settings.auxiliaryAlias !== null
              ? `alias:${settings.auxiliaryAlias}`
              : settings.auxiliary === null
                ? ''
                : keyOf(settings.auxiliary)
          }
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value.startsWith('alias:')) {
              save(preferences(settings.models, null, value.slice('alias:'.length)));
              return;
            }
            const model = models.find((m) => keyOf(m) === value);
            save(
              preferences(
                settings.models,
                model === undefined ? null : { provider: model.provider, id: model.id },
                null,
              ),
            );
          }}
        >
          <option value="">{t('models.auxiliary.session')}</option>
          {MODEL_ALIASES.map((alias) => (
            <option key={alias} value={`alias:${alias}`}>
              {t('models.auxiliary.alias', { alias })}
            </option>
          ))}
          {models.map((m) => (
            <option key={keyOf(m)} value={keyOf(m)}>
              {settings.models[keyOf(m)]?.displayName ?? m.name} ({m.provider})
            </option>
          ))}
        </select>
      </SettingsRow>
      {models.length === 0 ? (
        <p className="settings-row-note">{t('models.settings.none')}</p>
      ) : chosen === undefined ? (
        <ul className="provider-list">
          {models.map((m) => {
            const o = settings.models[keyOf(m)];
            return (
              <li key={keyOf(m)} data-testid={`model-row-${keyOf(m)}`}>
                <div>
                  <strong>{o?.displayName ?? m.name}</strong>
                  <div className="muted small">
                    {keyOf(m)} · {format.number(o?.contextWindow ?? m.contextWindow)}
                  </div>
                </div>
                <Button
                  size="small"
                  data-testid={`model-edit-${keyOf(m)}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(keyOf(m));
                  }}
                >
                  {t('models.settings.edit')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ModelForm
          model={chosen}
          current={settings.models[keyOf(chosen)]}
          busy={busy}
          onCancel={() => {
            setEditing(undefined);
          }}
          onSave={(override) => {
            const key = keyOf(chosen);
            const next = Object.fromEntries(
              Object.entries(settings.models).filter(([k]) => k !== key),
            );
            if (Object.keys(override).length > 0) next[key] = override;
            save(preferences(next, settings.auxiliary));
            setEditing(undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}
