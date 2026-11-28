// Both places that name a session commit on Return or focus-out and cancel on Escape.
import { useRef, type RefObject } from 'react';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useUi } from './ui.js';

export function SessionTitleInput({
  id,
  title,
  trigger,
  onClose,
}: {
  readonly id: string;
  readonly title: string | undefined;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const t = useT();
  const ui = useUi();
  const closed = useRef(false);
  const finish = (text: string | undefined, restoreFocus: boolean) => {
    if (closed.current) return;
    closed.current = true;
    onClose();
    const value = text?.trim();
    if (value && value !== title) {
      window.piarc.renameSession(id, value).catch((error: unknown) => {
        ui.addToast({ sessionId: id, text: String(error) });
      });
    }
    if (restoreFocus)
      requestAnimationFrame(() => {
        trigger.current?.focus();
      });
  };
  return (
    <input
      className="rename-input"
      type="text"
      autoFocus
      defaultValue={title ?? ''}
      aria-label={t('session.renameLabel')}
      maxLength={200}
      data-testid="rename-input"
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onBlur={(event) => {
        finish(event.currentTarget.value, false);
      }}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent) || (event.key !== 'Enter' && event.key !== 'Escape'))
          return;
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === 'Enter' ? event.currentTarget.value : undefined, true);
      }}
    />
  );
}
