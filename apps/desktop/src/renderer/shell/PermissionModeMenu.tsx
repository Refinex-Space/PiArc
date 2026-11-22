import type { Ref } from 'react';
import type { PermissionMode } from '../../shared/ipc.js';
import { useApp } from '../app/app-context.js';
import { MenuPopup, useMenu } from './Menu.js';

const MODES = ['default', 'acceptEdits', 'plan'] as const;

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
  // Bypass is offered only after the user enabled it in settings; the main process asks once
  // more before switching (T23). Auto review (T46) is always listed: until the user enables it
  // in settings it cannot be chosen and says where to enable it.
  const auto = preferences.permissions.enableAutoMode;
  const modes: readonly PermissionMode[] = [
    ...MODES,
    'auto',
    ...(preferences.permissions.enableBypassPermissions ? (['bypassPermissions'] as const) : []),
  ];
  return (
    <>
      <button
        ref={buttonRef}
        className="row-action"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        disabled={mode === undefined}
        data-testid="permission-mode"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          menu.openAt(rect.left, rect.top);
        }}
      >
        {mode === undefined ? t('approval.modeMenu') : t(`approval.mode.${mode}`)} ▾
      </button>
      {menu.open && (
        <MenuPopup
          label={t('approval.modeMenu')}
          at={menu.open}
          numbered
          onClose={menu.close}
          items={modes.map((next) => ({
            id: next,
            label: t(`approval.mode.${next}`),
            ...(next === 'auto' && !auto
              ? { disabled: true, hint: t('permissions.auto.menuOff') }
              : {}),
            run: () => {
              // Selecting Auto review again lifts a pause (Core, T46).
              if (next !== mode || next === 'auto') {
                window.piarc.setPermissionMode(id, next).catch(onError);
              }
            },
          }))}
        />
      )}
    </>
  );
}
