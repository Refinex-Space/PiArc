// Core's notices for the user (`core/notices`, I76): for example Git Bash missing on Windows,
// with its download link (opened in the system browser after the main process's confirmation).
import { isMessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { useNotices, useStore } from '../store/hooks.js';

export function NoticeBar() {
  const t = useT();
  const store = useStore();
  const notices = useNotices();
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices" data-testid="notices">
      {notices.map((notice) => {
        const id = `notice.${notice.type}`;
        return (
          <div key={notice.type} className="notice" role="alert">
            <span>{isMessageId(id) ? t(id) : notice.message}</span>
            {notice.downloadUrl !== undefined && (
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  if (notice.downloadUrl !== undefined) {
                    void window.piarc.openExternal(notice.downloadUrl);
                  }
                }}
              >
                {t('notice.download')}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t('toast.dismiss')}
              onClick={() => {
                store.dismissNotice(notice.type);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
