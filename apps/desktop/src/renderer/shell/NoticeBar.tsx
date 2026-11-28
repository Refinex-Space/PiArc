// Core's notices for the user (`core/notices`, I76): for example Git Bash missing on Windows,
// with its download link (opened in the system browser after the main process's confirmation),
// and hooks' `systemMessage`s and errors (T25), labelled with their event. They sit above the
// input as quiet cards; only the icon carries how serious a notice is.
import { isMessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { useNotices, useStore } from '../store/hooks.js';
import { CloseGlyph, InfoGlyph, WarningGlyph } from './icons.js';

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
        const tone = notice.hook === undefined ? 'warning' : notice.hook.error ? 'danger' : 'info';
        return (
          <div key={notice.key} className="notice" role="alert" data-tone={tone}>
            <span className="notice-icon" aria-hidden="true">
              {tone === 'info' ? <InfoGlyph /> : <WarningGlyph />}
            </span>
            <span className="notice-text">
              {notice.hook !== undefined && (
                <strong>
                  {t(notice.hook.error ? 'notice.hookError' : 'notice.hookMessage', {
                    event: notice.hook.event,
                  })}
                </strong>
              )}
              <span>
                {notice.hook === undefined && notice.workspace === undefined && isMessageId(id)
                  ? t(id)
                  : notice.message}
              </span>
            </span>
            {notice.type === 'gitignore' && notice.workspace !== undefined && (
              <button
                type="button"
                className="button button-small"
                data-testid="notice-gitignore"
                onClick={() => {
                  const { workspace } = notice;
                  if (workspace === undefined) return;
                  window.piarc.ignoreWorktrees(workspace).then(
                    () => {
                      store.dismissNotice(notice.key);
                    },
                    (error: unknown) => {
                      console.error('[notice] adding the .gitignore line failed', error);
                    },
                  );
                }}
              >
                {t('notice.gitignoreAdd')}
              </button>
            )}
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
            <IconButton
              label={t('toast.dismiss')}
              size="xs"
              className="notice-dismiss"
              onClick={() => {
                store.dismissNotice(notice.key);
              }}
            >
              <CloseGlyph />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
