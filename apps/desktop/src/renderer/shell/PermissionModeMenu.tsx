import type { Ref } from 'react';
import type { PermissionMode } from '../../shared/ipc.js';
import type { Preferences } from '../../shared/preferences.js';
import { useApp, type AppContextValue } from '../app/app-context.js';
import { choiceName, MenuPopup, useMenu, type MenuItem } from './Menu.js';

/**
 * The mode choices of a session and of the new-session view. Bypass permissions is listed once
 * enabled in settings; the main process confirms it natively when it applies (for a new session,
 * when the first message is sent).
 */
export function permissionChoices(
  t: AppContextValue['t'],
  permissions: Preferences['permissions'],
  current: PermissionMode | undefined,
  choose: (mode: PermissionMode) => void,
): MenuItem[] {
  const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
  if (permissions.enableBypassPermissions) modes.push('bypassPermissions');
  const hints = {
    default: 'workbench.mode.manualHint',
    acceptEdits: 'workbench.mode.editHint',
    plan: 'workbench.mode.planHint',
    auto: permissions.enableAutoMode ? 'workbench.mode.autoHint' : 'permissions.auto.menuOff',
    bypassPermissions: 'permissions.bypass.detail',
  } as const;
  return modes.map((mode) => ({
    id: mode,
    label: t(`approval.mode.${mode}`),
    selected: current === mode,
    disabled: mode === 'auto' && !permissions.enableAutoMode,
    hint: t(hints[mode]),
    run: () => {
      choose(mode);
    },
  }));
}

export function PermissionModeMenu({
  id,
  mode,
  buttonRef,
  onError,
}: {
  readonly id: string;
  readonly mode: PermissionMode | undefined;
  readonly buttonRef: Ref<HTMLButtonElement>;
  readonly onError: (error: unknown) => void;
}) {
  const { t, preferences } = useApp();
  const menu = useMenu();
  const label = mode === undefined ? t('approval.modeMenu') : t(`approval.mode.${mode}`);
  return (
    <>
      <button
        ref={buttonRef}
        className="choice-button"
        type="button"
        aria-haspopup="menu"
        title={t('approval.modeMenu')}
        aria-expanded={menu.open !== null}
        disabled={mode === undefined}
        data-testid="permission-mode"
        data-mode={mode}
        aria-label={choiceName(label, t('approval.modeMenu'))}
        onClick={(event) => {
          menu.openAbove(event.currentTarget);
        }}
      >
        {label}
      </button>
      {menu.open && (
        <MenuPopup
          label={t('approval.modeMenu')}
          heading={t('approval.modeMenu')}
          at={menu.open}
          numbered
          onClose={menu.close}
          items={permissionChoices(t, preferences.permissions, mode, (next) => {
            if (next !== mode || next === 'auto')
              window.piarc.setPermissionMode(id, next).catch(onError);
          })}
        />
      )}
    </>
  );
}
