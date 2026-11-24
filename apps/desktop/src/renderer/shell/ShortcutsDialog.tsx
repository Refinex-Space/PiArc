// The keyboard shortcut list (Mod+/, `/help`): every registered command with its current key,
// and the composer's built-in slash commands (the others are in the `/` palette, T37).
import { useId } from 'react';

import { COMMANDS, effectiveBindings } from '../../shared/keybindings.js';
import { BUILTIN_NAMES, builtin } from '../composer/builtins.js';
import { useApp } from '../app/app-context.js';
import { Keycaps } from '../app/Keycaps.js';
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
            const key = bindings[command.id];
            return (
              <tr key={command.id} data-command={command.id}>
                <td>{t(command.label)}</td>
                <td>
                  {key ? (
                    <Keycaps binding={key} platform={keyPlatform} />
                  ) : (
                    t('settings.shortcuts.unbound')
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3 className="dialog-subtitle">{t('help.title')}</h3>
      <table className="shortcut-table" data-testid="help-commands">
        <tbody>
          {BUILTIN_NAMES.map((name) => {
            const label = builtin(name)?.label;
            return (
              <tr key={name} data-command={name}>
                <td>
                  <code>/{name}</code>
                </td>
                <td>{label === undefined ? null : t(label)}</td>
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
