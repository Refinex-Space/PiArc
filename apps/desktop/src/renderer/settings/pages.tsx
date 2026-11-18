// The settings pages of T18: General (language, notifications), Appearance (theme, contrast,
// density, motion) and Keyboard Shortcuts (every registered command; changes take effect at
// once in every window and in the menu; conflicts are refused with a message).
import { useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import {
  COMMANDS,
  chordOfEvent,
  conflictFor,
  displayKey,
  effectiveBindings,
  formatKey,
  isAssignable,
  type CommandId,
} from '../../shared/keybindings.js';
import {
  CONTRASTS,
  DENSITY_PREFERENCES,
  LANGUAGES,
  MOTIONS,
  THEMES,
  type PreferenceChange,
} from '../../shared/preferences.js';
import { useApp } from '../app/app-context.js';
import { registerSettingsPage } from './registry.js';

function useSave(): { save: (change: PreferenceChange) => void; error: string | undefined } {
  const { t } = useApp();
  const [error, setError] = useState<string | undefined>(undefined);
  return {
    error,
    save: (change) => {
      setError(undefined);
      window.piarc.setPreference(change).catch((failure: unknown) => {
        setError(
          t('settings.saveFailed', {
            reason: failure instanceof Error ? failure.message : String(failure),
          }),
        );
      });
    },
  };
}

function Choice<T extends string>({
  label,
  name,
  options,
  value,
  labelOf,
  onChange,
}: {
  readonly label: MessageId;
  readonly name: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly labelOf: (option: T) => MessageId;
  readonly onChange: (value: T) => void;
}) {
  const { t } = useApp();
  const id = useId();
  return (
    <fieldset className="setting" data-testid={`setting-${name}`}>
      <legend id={id} className="setting-label">
        {t(label)}
      </legend>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((option) => (
          <label key={option} className={`segment${option === value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={option === value}
              data-testid={`${name}-${option}`}
              onChange={() => {
                onChange(option);
              }}
            />
            {t(labelOf(option))}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function GeneralPage() {
  const { t, preferences } = useApp();
  const { save, error } = useSave();
  const languageId = useId();
  return (
    <div className="settings-section">
      <div className="setting">
        <label htmlFor={languageId} className="setting-label">
          {t('settings.language')}
        </label>
        <select
          id={languageId}
          className="input"
          value={preferences.language}
          data-testid="setting-language"
          onChange={(event) => {
            const value = LANGUAGES.find((l) => l === event.currentTarget.value);
            if (value !== undefined) {
              save({ key: 'language', value });
            }
          }}
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {t(`settings.language.${language}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <span className="setting-label">{t('settings.notifications')}</span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={preferences.notifications.enabled}
            data-testid="setting-notifications"
            onChange={(event) => {
              save({ key: 'notifications.enabled', value: event.currentTarget.checked });
            }}
          />
          {t('settings.notifications.enabled')}
        </label>
      </div>
      {error !== undefined && <p className="error-text">{error}</p>}
    </div>
  );
}

function AppearancePage() {
  const { preferences } = useApp();
  const { save, error } = useSave();
  const { appearance } = preferences;
  return (
    <div className="settings-section">
      <Choice
        label="settings.theme"
        name="theme"
        options={THEMES}
        value={appearance.theme}
        labelOf={(o) => `settings.theme.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.theme', value });
        }}
      />
      <Choice
        label="settings.contrast"
        name="contrast"
        options={CONTRASTS}
        value={appearance.contrast}
        labelOf={(o) => `settings.contrast.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.contrast', value });
        }}
      />
      <Choice
        label="settings.density"
        name="density"
        options={DENSITY_PREFERENCES}
        value={appearance.density}
        labelOf={(o) => `settings.density.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.density', value });
        }}
      />
      <Choice
        label="settings.reduceMotion"
        name="reduceMotion"
        options={MOTIONS}
        value={appearance.reduceMotion}
        labelOf={(o) => `settings.reduceMotion.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.reduceMotion', value });
        }}
      />
      {error !== undefined && <p className="error-text">{error}</p>}
    </div>
  );
}

function ShortcutsPage() {
  const { t, preferences, keyPlatform } = useApp();
  const { save, error } = useSave();
  const bindings = effectiveBindings(preferences.keybindings);
  const [recording, setRecording] = useState<CommandId | undefined>(undefined);
  const [problem, setProblem] = useState<{ command: CommandId; text: string } | undefined>(
    undefined,
  );
  const modifiers = keyPlatform === 'mac' ? '⌘, ⌃, ⌥' : 'Ctrl, Alt';
  const record = (command: CommandId, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setRecording(undefined);
      return;
    }
    const chord = chordOfEvent(event.nativeEvent, keyPlatform);
    if (chord === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!isAssignable(chord)) {
      setProblem({ command, text: t('settings.shortcuts.invalid', { modifiers }) });
      return;
    }
    const key = formatKey(chord);
    const clash = conflictFor(key, command, bindings, keyPlatform);
    if (clash !== undefined) {
      const spec = COMMANDS.find((c) => c.id === clash);
      setProblem({
        command,
        text: t('settings.shortcuts.conflict', {
          key: displayKey(key, keyPlatform),
          command: spec === undefined ? clash : t(spec.label),
        }),
      });
      return;
    }
    setProblem(undefined);
    setRecording(undefined);
    save({ key: 'keybinding', command, value: key });
  };
  return (
    <div className="settings-section">
      <table className="shortcut-table shortcut-editor">
        <thead>
          <tr>
            <th>{t('settings.shortcuts.command')}</th>
            <th>{t('settings.shortcuts.key')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map((command) => {
            const key = displayKey(bindings[command.id], keyPlatform);
            const overridden = preferences.keybindings[command.id] !== undefined;
            const isRecording = recording === command.id;
            return (
              <tr key={command.id} data-testid={`shortcut-${command.id}`}>
                <td>{t(command.label)}</td>
                <td>
                  <button
                    type="button"
                    className={`key-button${isRecording ? ' is-recording' : ''}`}
                    aria-label={t('settings.shortcuts.change', { command: t(command.label) })}
                    data-testid={`shortcut-key-${command.id}`}
                    onClick={() => {
                      setProblem(undefined);
                      setRecording(command.id);
                    }}
                    onBlur={() => {
                      if (isRecording) {
                        setRecording(undefined);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (isRecording) {
                        record(command.id, event);
                      }
                    }}
                  >
                    {isRecording ? (
                      t('settings.shortcuts.recording')
                    ) : key.length > 0 ? (
                      <kbd>{key}</kbd>
                    ) : (
                      t('settings.shortcuts.unbound')
                    )}
                  </button>
                  {problem?.command === command.id && (
                    <p className="error-text small" role="alert" data-testid="shortcut-problem">
                      {problem.text}
                    </p>
                  )}
                </td>
                <td>
                  {overridden && (
                    <button
                      type="button"
                      className="button button-small"
                      data-testid={`shortcut-reset-${command.id}`}
                      onClick={() => {
                        save({ key: 'keybinding', command: command.id, value: null });
                      }}
                    >
                      {t('settings.shortcuts.reset')}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error !== undefined && <p className="error-text">{error}</p>}
    </div>
  );
}

/** Registers T18's pages; later tasks register theirs the same way. */
export function registerBuiltInSettingsPages(): void {
  registerSettingsPage({
    id: 'general',
    title: 'settings.general',
    order: 0,
    component: GeneralPage,
  });
  registerSettingsPage({
    id: 'appearance',
    title: 'settings.appearance',
    order: 10,
    component: AppearancePage,
  });
  registerSettingsPage({
    id: 'shortcuts',
    title: 'settings.shortcuts',
    order: 90,
    component: ShortcutsPage,
  });
}
