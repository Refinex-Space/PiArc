// `/output-style` without a name (T37): the workspace's output styles, the current one marked.
// Choosing one writes the workspace's `.piarc/settings.local.json` through Core; the sessions
// get the new style with their next message.
import { useId } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import type { StyleChoice } from '../composer/commands-list.js';
import { Dialog } from './Dialog.js';

const BUILT_IN: Readonly<Record<string, MessageId>> = {
  Default: 'outputStyle.builtin.Default',
  Concise: 'outputStyle.builtin.Concise',
  Explanatory: 'outputStyle.builtin.Explanatory',
  Proactive: 'outputStyle.builtin.Proactive',
};

/** The description of a style: the client's for built-in ones, Core's text otherwise. */
export function styleDescription(t: (id: MessageId) => string, style: StyleChoice): string {
  const id =
    style.source === 'builtIn' && Object.hasOwn(BUILT_IN, style.name)
      ? BUILT_IN[style.name]
      : undefined;
  return id === undefined ? style.description : t(id);
}

export function OutputStyleDialog({
  styles,
  current,
  onChoose,
  onClose,
}: {
  readonly styles: readonly StyleChoice[];
  readonly current: string;
  readonly onChoose: (name: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useApp();
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="output-style-dialog">
      <h2 id={titleId} className="dialog-title">
        {t('outputStyle.title')}
      </h2>
      <p className="muted">{t('outputStyle.note')}</p>
      <ul className="style-list" aria-labelledby={titleId}>
        {styles.map((style) => (
          <li key={style.name}>
            <button
              type="button"
              className={style.name === current ? 'style-choice is-current' : 'style-choice'}
              aria-current={style.name === current ? 'true' : undefined}
              data-style={style.name}
              {...(style.name === current ? { 'data-autofocus': true } : {})}
              onClick={() => {
                onChoose(style.name);
              }}
            >
              <span className="style-name">{style.name}</span>
              <span className="muted">{styleDescription(t, style)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          {t('shortcuts.close')}
        </button>
      </div>
    </Dialog>
  );
}
