// The sidebar's update notice (ADR-0111, design addendum about-and-updates.md): one quiet line
// above the footer while a newer release is available, downloading or ready. It never
// interrupts: no dialog, no toast. "Available" opens the About page; "ready" restarts to
// install (the main process still confirms running work natively).
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { useUi } from '../shell/ui.js';
import { useUpdateStatus } from './update-store.js';
import { noticeOf, percentOf } from './update-status.js';

export function UpdateNotice() {
  const { t, format } = useApp();
  const ui = useUi();
  const status = useUpdateStatus();
  const notice = noticeOf(status);
  if (status === undefined || notice === undefined) return null;
  const label = notice.ready
    ? t('updates.notice.ready', { version: notice.version })
    : status.state === 'downloading'
      ? t('updates.notice.downloading', {
          version: notice.version,
          percent: format.number(percentOf(status)),
        })
      : t(notice.security ? 'updates.notice.security' : 'updates.notice.available', {
          version: notice.version,
        });
  const open = (): void => {
    if (!notice.ready) {
      void window.piarc.openSettings('about');
      return;
    }
    window.piarc.installUpdate().then(
      (outcome) => {
        if (outcome.kind === 'manual') void window.piarc.openSettings('about');
      },
      (failure: unknown) => {
        ui.addToast({
          sessionId: '',
          text: t('updates.notice.failed', { reason: reason(failure) }),
          action: {
            label: t('settings.about'),
            run: () => {
              void window.piarc.openSettings('about');
            },
          },
        });
      },
    );
  };
  return (
    <div className="sidebar-update">
      <button
        type="button"
        className="sidebar-update-button"
        data-testid="sidebar-update"
        data-state={status.state}
        data-security={notice.security}
        onClick={open}
      >
        <span className="sidebar-update-dot" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
