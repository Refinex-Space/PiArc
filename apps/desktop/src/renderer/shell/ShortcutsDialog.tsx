// The keyboard shortcut list (Mod+/): every registered command with its current key.
import { useId } from 'react';

import { COMMANDS, displayKey, effectiveBindings } from '../../shared/keybindings.js';
import { useApp } from '../app/app-context.js';
import { Dialog } from './Dialog.js';

export function ShortcutsDialog({ onClose }: { readonly onClose: () => void }) {
  const { t, preferences, keyPlatform } = useApp();
  const titleId = useId();
  const bindings = effectiveBindings(preferences.keybindings);
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="shortcuts-dialog">
      <h2 id={titleId} className="dialog-title">
        {t('shortcuts.title')}
      </h2>
      <table className="shortcut-table">
        <tbody>
          {COMMANDS.map((command) => {
            const key = displayKey(bindings[command.id], keyPlatform);
            return (
              <tr key={command.id} data-command={command.id}>
                <td>{t(command.label)}</td>
                <td>
                  <kbd>{key.length > 0 ? key : t('settings.shortcuts.unbound')}</kbd>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="dialog-actions">
        <button type="button" className="button" data-autofocus onClick={onClose}>
          {t('shortcuts.close')}
        </button>
      </div>
    </Dialog>
  );
}
