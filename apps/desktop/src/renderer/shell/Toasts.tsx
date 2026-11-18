// In-app reminders (architecture section 8.8, I43): shown for sessions that need the user even
// when a system notification also appeared, since on macOS the app cannot tell whether one did.
import { useEffect } from 'react';

import { useT } from '../app/app-context.js';
import { useUi } from './ui.js';

/** How long a reminder stays. */
const TOAST_MS = 8000;

export function Toasts() {
  const t = useT();
  const ui = useUi();
  const { toasts, dismissToast } = ui;
  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }
    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        dismissToast(toast.id);
      }, TOAST_MS),
    );
    return () => {
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
    };
  }, [toasts, dismissToast]);
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="toasts" role="status" data-testid="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-testid="toast">
          <span className="toast-text">{toast.text}</span>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              dismissToast(toast.id);
              ui.show({ kind: 'session', id: toast.sessionId });
            }}
          >
            {t('toast.open')}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('toast.dismiss')}
            onClick={() => {
              dismissToast(toast.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
