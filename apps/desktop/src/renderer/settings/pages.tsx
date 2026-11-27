// The settings pages: General (language, notifications, memory), Appearance (theme, contrast,
// density, motion) and Keyboard Shortcuts (every registered command; changes take effect at
// once in every window and in the menu; conflicts are refused with a message).
import { useEffect, useId, useState, type ReactNode } from 'react';

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
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { ConfigDiagnosticsPage } from './ConfigDiagnosticsPage.js';
import { PermissionsPage } from './PermissionsPage.js';
import { SandboxPage } from './SandboxPage.js';
import { ProxyPage } from './ProxyPage.js';
import { VoicePage } from './VoicePage.js';
import { GitPage } from './GitPage.js';
import { BrowserPage } from './BrowserPage.js';
import { ProvidersPage } from './ProvidersPage.js';
import { ManagedBadge, useIsManaged } from './managed.js';
import { registerSettingsPage } from './registry.js';
import { AgentsPage } from './AgentsPage.js';
import { McpPage } from './McpPage.js';
import { MarkdownPage } from './MarkdownPage.js';
import { MemoryPage } from './MemoryPage.js';
import { SkillsPage } from './SkillsPage.js';
import { UsagePage } from '../usage/UsagePage.js';
import { Keycaps } from '../app/Keycaps.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { Button } from '../app/Button.js';

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
            reason: reason(failure),
          }),
        );
      });
    },
  };
}

function themeIcon(theme: (typeof THEMES)[number]) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {theme === 'system' ? (
        <>
          <rect x="2.75" y="4" width="18.5" height="13.25" rx="2" />
          <path d="M12 17.25v3M8.5 20.25h7" />
        </>
      ) : theme === 'light' ? (
        <>
          <circle cx="12" cy="12" r="4.25" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      ) : (
        <path d="M20.8 14.7a9.25 9.25 0 0 1-11.5-11.5A9.25 9.25 0 1 0 20.8 14.7Z" />
      )}
    </svg>
  );
}

function Choice<T extends string>({
  label,
  hint,
  name,
  pointer,
  options,
  value,
  labelOf,
  iconOf,
  menu,
  onChange,
}: {
  readonly label: MessageId;
  readonly hint?: MessageId;
  readonly name: string;
  readonly pointer: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly labelOf: (option: T) => MessageId;
  readonly iconOf?: (option: T) => ReactNode;
  readonly menu?: boolean;
  readonly onChange: (value: T) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const hintId = hint ? id + '-hint' : undefined;
  const managed = useIsManaged(pointer);
  return (
    <div className="preference-row" data-testid={`setting-${name}`}>
      <div className="preference-copy">
        <span id={id}>
          {t(label)}
          {managed && <ManagedBadge testId={`managed-${name}`} />}
        </span>
        {hint && <p id={hintId}>{t(hint)}</p>}
      </div>
      {menu ? (
        <select
          className="input preference-select-ghost"
          value={value}
          disabled={managed}
          aria-labelledby={id}
          aria-describedby={hintId}
          onChange={(event) => {
            const next = options.find((option) => option === event.currentTarget.value);
            if (next !== undefined) onChange(next);
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {t(labelOf(option))}
            </option>
          ))}
        </select>
      ) : (
        <SegmentedControl
          options={options}
          value={value}
          onChange={onChange}
          disabled={managed}
          name={name}
          testIdPrefix={name}
          aria-labelledby={id}
          labelOf={(option) => t(labelOf(option))}
          {...(hintId && { 'aria-describedby': hintId })}
          {...(iconOf && { iconOf })}
        />
      )}
    </div>
  );
}

function GeneralPage() {
  const { t, preferences, notificationsSupported } = useApp();
  const [notificationInfo, setNotificationInfo] = useState<boolean | string>(
    notificationsSupported,
  );
  // The workbench can stay open while OS notification availability changes. Read only the
  // capability when visiting this page; live preferences still come from AppProvider.
  useEffect(() => {
    let active = true;
    window.piarc.getAppState().then(
      (snapshot) => {
        if (active) setNotificationInfo(snapshot.notificationsSupported);
      },
      (failure: unknown) => {
        if (active) setNotificationInfo(reason(failure));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const { save, error } = useSave();
  const languageId = useId();
  const notificationDescription = useId();
  const notificationLabel = useId();
  const managedLanguage = useIsManaged('/language');
  const managedNotifications = useIsManaged('/notifications/enabled');
  const managedReadBoth = useIsManaged('/memory/readBoth');
  return (
    <div className="preference-rows">
      <div className="preference-row">
        <label htmlFor={languageId} className="preference-copy">
          {t('settings.language')}
          {managedLanguage && <ManagedBadge testId="managed-language" />}
        </label>
        <select
          id={languageId}
          className="input preference-language"
          value={preferences.language}
          disabled={managedLanguage}
          data-testid="setting-language"
          onChange={(event) => {
            const value = LANGUAGES.find((l) => l === event.currentTarget.value);
            if (value !== undefined) save({ key: 'language', value });
          }}
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {t(`settings.language.${language}`)}
            </option>
          ))}
        </select>
      </div>
      <label className="preference-row">
        <span className="preference-copy">
          <span>
            {t('settings.notifications')}
            {managedNotifications && <ManagedBadge testId="managed-notifications" />}
          </span>
          <span className="preference-description" id={notificationLabel}>
            {t('settings.notifications.enabled')}
          </span>
          <span
            className="preference-description"
            id={notificationDescription}
            data-testid="setting-notifications-note"
          >
            {typeof notificationInfo === 'string'
              ? notificationInfo
              : t(
                  notificationInfo
                    ? 'settings.notifications.actions'
                    : 'settings.notifications.unsupported',
                )}
          </span>
        </span>
        <input
          type="checkbox"
          className="preference-switch"
          checked={preferences.notifications.enabled}
          disabled={managedNotifications}
          aria-labelledby={notificationLabel}
          aria-describedby={notificationDescription}
          data-testid="setting-notifications"
          onChange={(event) => {
            save({ key: 'notifications.enabled', value: event.currentTarget.checked });
          }}
        />
      </label>
      <label className="preference-row">
        <span className="preference-copy">
          <span>
            {t('settings.memory')}
            {managedReadBoth && <ManagedBadge testId="managed-read-both" />}
          </span>
          <span className="preference-description">{t('settings.memory.readBoth')}</span>
        </span>
        <input
          type="checkbox"
          className="preference-switch"
          checked={preferences.memory.readBoth}
          disabled={managedReadBoth}
          data-testid="setting-memory-read-both"
          onChange={(event) => {
            save({ key: 'memory.readBoth', value: event.currentTarget.checked });
          }}
        />
      </label>
      {error !== undefined && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AppearancePage() {
  const { preferences } = useApp();
  const { save, error } = useSave();
  const { appearance } = preferences;
  return (
    <div className="preference-rows">
      <Choice
        label="settings.theme"
        name="theme"
        pointer="/appearance/theme"
        options={THEMES}
        value={appearance.theme}
        iconOf={themeIcon}
        labelOf={(o) => `settings.theme.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.theme', value });
        }}
      />
      <Choice
        label="settings.reduceMotion"
        name="reduceMotion"
        pointer="/appearance/reduceMotion"
        options={MOTIONS}
        value={appearance.reduceMotion}
        menu
        labelOf={(o) => `settings.reduceMotion.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.reduceMotion', value });
        }}
      />
      <Choice
        label="settings.contrast"
        name="contrast"
        pointer="/appearance/contrast"
        hint="settings.contrast.hint"
        options={CONTRASTS}
        value={appearance.contrast}
        menu
        labelOf={(o) => `settings.contrast.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.contrast', value });
        }}
      />
      <Choice
        label="settings.density"
        name="density"
        pointer="/appearance/density"
        hint="settings.density.hint"
        options={DENSITY_PREFERENCES}
        value={appearance.density}
        labelOf={(o) => `settings.density.${o}`}
        onChange={(value) => {
          save({ key: 'appearance.density', value });
        }}
      />
      {error !== undefined && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
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
    if (isImeComposing(event.nativeEvent)) {
      return;
    }
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setRecording(undefined);
      setProblem(undefined);
      return;
    }
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.stopPropagation();
      setProblem(undefined);
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
    <div className="shortcut-preferences">
      <p className="shortcut-help muted">{t('settings.shortcuts.hint')}</p>
      <table className="shortcut-table shortcut-editor">
        <thead>
          <tr>
            <th scope="col">{t('settings.shortcuts.command')}</th>
            <th scope="col">{t('settings.shortcuts.key')}</th>
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map((command) => {
            const binding = bindings[command.id];
            const overridden = preferences.keybindings[command.id] !== undefined;
            const isRecording = recording === command.id;
            const message = problem?.command === command.id ? problem.text : undefined;
            const nameId = 'shortcut-label-' + command.id;
            const valueId = 'shortcut-value-' + command.id;
            const errorId = 'shortcut-error-' + command.id;
            return (
              <tr key={command.id} data-testid={`shortcut-${command.id}`}>
                <th scope="row">
                  <span id={nameId}>{t(command.label)}</span>
                  {message && (
                    <p
                      id={errorId}
                      className="error-text small"
                      role="alert"
                      data-testid="shortcut-problem"
                    >
                      {message}
                    </p>
                  )}
                </th>
                <td>
                  <div className="shortcut-actions">
                    {overridden && (
                      <Button
                        variant="ghost"
                        size="small"
                        data-testid={`shortcut-reset-${command.id}`}
                        onClick={() => {
                          save({ key: 'keybinding', command: command.id, value: null });
                        }}
                      >
                        {t('settings.shortcuts.reset')}
                      </Button>
                    )}
                    <button
                      type="button"
                      className="shortcut-recorder"
                      aria-pressed={isRecording}
                      aria-label={[
                        isRecording
                          ? t('settings.shortcuts.recording')
                          : displayKey(binding, keyPlatform) || t('settings.shortcuts.unbound'),
                        t('settings.shortcuts.change', { command: t(command.label) }),
                      ].join(' · ')}
                      aria-describedby={message ? valueId + ' ' + errorId : valueId}
                      data-testid={`shortcut-key-${command.id}`}
                      title={t('settings.shortcuts.change', { command: t(command.label) })}
                      onClick={() => {
                        setProblem(undefined);
                        setRecording(command.id);
                      }}
                      onBlur={() => {
                        if (isRecording) {
                          setRecording(undefined);
                          setProblem(undefined);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (isRecording) record(command.id, event);
                      }}
                    >
                      {!isRecording && (
                        <svg
                          className="shortcut-edit-mark"
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m10.9 2.2 2.9 2.9-7.7 7.7-3.8.9.9-3.8z M9.5 3.6l2.9 2.9" />
                        </svg>
                      )}
                      <span id={valueId}>
                        {isRecording ? (
                          t('settings.shortcuts.recording')
                        ) : binding ? (
                          <Keycaps binding={binding} platform={keyPlatform} />
                        ) : (
                          t('settings.shortcuts.unbound')
                        )}
                      </span>
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error !== undefined && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Registers T18's pages; later tasks register theirs the same way. */
export function registerBuiltInSettingsPages(): void {
  registerSettingsPage({
    id: 'markdown',
    title: 'files.images.markdown',
    order: 12,
    component: MarkdownPage,
  });
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
    id: 'providers',
    title: 'settings.providers',
    order: 20,
    component: ProvidersPage,
  });
  registerSettingsPage({
    id: 'permissions',
    title: 'settings.permissions',
    order: 30,
    component: PermissionsPage,
  });
  registerSettingsPage({
    id: 'sandbox',
    title: 'settings.sandbox',
    order: 35,
    component: SandboxPage,
  });
  registerSettingsPage({
    id: 'voice',
    title: 'settings.voice',
    order: 15,
    component: VoicePage,
  });
  registerSettingsPage({
    id: 'proxy',
    title: 'settings.proxy',
    order: 37,
    component: ProxyPage,
  });
  registerSettingsPage({
    id: 'git',
    title: 'settings.git',
    order: 38,
    component: GitPage,
  });
  registerSettingsPage({
    id: 'browser',
    title: 'settings.browser',
    order: 39,
    component: BrowserPage,
  });
  registerSettingsPage({
    id: 'agents',
    title: 'settings.agents',
    order: 40,
    component: AgentsPage,
  });
  registerSettingsPage({
    id: 'skills',
    title: 'settings.skills',
    order: 45,
    component: SkillsPage,
  });
  registerSettingsPage({
    id: 'memory',
    title: 'settings.autoMemory',
    order: 47,
    component: MemoryPage,
  });
  registerSettingsPage({
    id: 'mcp',
    title: 'settings.mcp',
    order: 50,
    component: McpPage,
  });
  registerSettingsPage({
    id: 'usage',
    title: 'settings.usage',
    order: 5,
    component: UsagePage,
  });
  registerSettingsPage({
    id: 'diagnostics',
    title: 'settings.configDiagnostics',
    order: 80,
    component: ConfigDiagnosticsPage,
  });
  registerSettingsPage({
    id: 'shortcuts',
    title: 'settings.shortcuts',
    order: 90,
    component: ShortcutsPage,
  });
}
