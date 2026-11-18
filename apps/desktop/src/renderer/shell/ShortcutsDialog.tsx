// The keyboard shortcut list (Mod+/, `/help`): every registered command with its current key,
// and the composer's slash commands from Core.
import { useId } from 'react';

import { COMMANDS, displayKey, effectiveBindings } from '../../shared/keybindings.js';
import { useApp } from '../app/app-context.js';
import { Dialog } from './Dialog.js';
import { useUi } from './ui.js';

export function ShortcutsDialog({ onClose }: { readonly onClose: () => void }) {
  const { t, preferences, keyPlatform } = useApp();
  const commands = useUi().composer?.commands ?? [];
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
      {commands.length === 0 ? null : (
        <>
          <h3 className="dialog-subtitle">{t('help.title')}</h3>
          <table className="shortcut-table" data-testid="help-commands">
            <tbody>
              {commands.map((command) => (
                <tr key={command.name} data-command={command.name}>
                  <td>
                    <code>/{command.name}</code>
                  </td>
                  <td>
                    {command.source === 'builtin' &&
                    (command.name === 'clear' ||
                      command.name === 'compact' ||
                      command.name === 'help')
                      ? t(`composer.command.${command.name}`)
                      : command.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" data-autofocus onClick={onClose}>
          {t('shortcuts.close')}
        </button>
      </div>
    </Dialog>
  );
}
