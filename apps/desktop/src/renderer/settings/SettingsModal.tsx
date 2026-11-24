// Native modality keeps the mounted workbench inert, including its portals and terminal.
// Defer settings code until the first open so the workbench can paint independently.
import { lazy, Suspense, useLayoutEffect, useRef } from 'react';

import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';

const SettingsContent = lazy(async () => {
  const [{ SettingsApp }, { registerBuiltInSettingsPages }] = await Promise.all([
    import('./SettingsApp.js'),
    import('./pages.js'),
  ]);
  registerBuiltInSettingsPages();
  return { default: SettingsApp };
});

export function SettingsModal({
  entry,
  onClose,
}: {
  readonly entry: number;
  readonly onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      // A settings link can replace its opener (e.g. the model picker).
      if (document.activeElement === document.body) {
        document
          .querySelector<HTMLElement>(
            '[data-testid="open-settings"], [data-testid="expand-sidebar"]',
          )
          ?.focus({ preventScroll: true });
      }
    };
  }, []);

  function outside(event: React.MouseEvent<HTMLDialogElement>): boolean {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX >= box.right ||
      event.clientY < box.top ||
      event.clientY >= box.bottom
    );
  }
  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-label={t('settings.title')}
      aria-modal="true"
      onPointerDown={(event) => {
        backdropPress.current = outside(event);
      }}
      onClick={(event) => {
        if (
          backdropPress.current &&
          outside(event) &&
          !event.currentTarget.querySelector('[role="dialog"]')
        )
          onClose();
        backdropPress.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isImeComposing(event.nativeEvent)) event.preventDefault();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!event.currentTarget.querySelector('[role="dialog"]')) onClose();
      }}
    >
      <Suspense fallback={null}>
        <SettingsContent key={entry} onClose={onClose} />
      </Suspense>
    </dialog>
  );
}
