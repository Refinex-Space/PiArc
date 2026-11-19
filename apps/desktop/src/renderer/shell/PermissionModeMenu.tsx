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
  // more before switching (T23).
  const modes: readonly PermissionMode[] = preferences.permissions.enableBypassPermissions
    ? [...MODES, 'bypassPermissions']
    : MODES;
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
            run: () => {
              if (next !== mode) window.piarc.setPermissionMode(id, next).catch(onError);
            },
          }))}
        />
      )}
    </>
  );
}
