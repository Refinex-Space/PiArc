// One session in the sidebar: badge, title, pinned and archived marks, and its actions (menu
// button or right click): rename in place, pin, archive, delete (confirmed by the main process).
import { memo, useState } from 'react';

import { isImeComposing } from '../composer/ime-guard.js';
import { useT } from '../app/app-context.js';
import { useSession } from '../store/hooks.js';
import { badgeOf } from '../store/status.js';
import { PinIcon } from './icons.js';
import { MenuButton, MenuPopup, useMenu, type MenuItem } from './Menu.js';
import { StatusBadge } from './StatusBadge.js';
import { useUi } from './ui.js';

/** The title the sidebar shows for a session. */
export function sessionTitle(title: string | undefined, fallback: string): string {
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : fallback;
}

function report(error: unknown): void {
  console.error('[sidebar] session action failed', error);
}

export const SessionRow = memo(function SessionRow({ id }: { readonly id: string }) {
  const t = useT();
  const ui = useUi();
  const session = useSession(id);
  const menu = useMenu();
  const [renaming, setRenaming] = useState(false);
  if (session === undefined) {
    return null;
  }
  const title = sessionTitle(session.title, t('session.untitled'));
  const selected = ui.view.kind === 'session' && ui.view.id === id;
  const items: MenuItem[] = [
    {
      id: 'rename',
      label: t('session.rename'),
      run: () => {
        setRenaming(true);
      },
    },
    {
      id: session.pinned ? 'unpin' : 'pin',
      label: t(session.pinned ? 'session.unpin' : 'session.pin'),
      run: () => {
        window.piarc.setSessionPinned(id, !session.pinned).catch(report);
      },
    },
    {
      id: session.archived ? 'unarchive' : 'archive',
      label: t(session.archived ? 'session.unarchive' : 'session.archive'),
      run: () => {
        if (!session.archived && selected) {
          ui.show({ kind: 'home', workspace: session.workspace });
        }
        window.piarc.setSessionArchived(id, !session.archived).catch(report);
      },
    },
    {
      id: 'delete',
      label: t('session.delete'),
      danger: true,
      run: () => {
        window.piarc.deleteSession(id, title).then((deleted) => {
          if (deleted && selected) {
            ui.show({ kind: 'home', workspace: session.workspace });
          }
        }, report);
      },
    },
  ];
  const commit = (value: string) => {
    setRenaming(false);
    const next = value.trim();
    if (next.length > 0 && next !== session.title) {
      window.piarc.renameSession(id, next).catch(report);
    }
  };
  return (
    <li
      className={`session-row${selected ? ' is-selected' : ''}${session.archived ? ' is-archived' : ''}`}
      data-testid="session-row"
      data-session-id={id}
      data-badge={badgeOf(session)}
      aria-current={selected ? 'page' : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAt(event.clientX, event.clientY);
      }}
    >
      <StatusBadge state={badgeOf(session)} />
      {renaming ? (
        <input
          className="rename-input"
          aria-label={t('session.renameLabel')}
          defaultValue={session.title ?? ''}
          maxLength={200}
          // The input replaces the title while renaming; focus goes straight into it.
          autoFocus
          data-testid="rename-input"
          onBlur={(event) => {
            commit(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) {
              return;
            }
            if (event.key === 'Enter') {
              commit(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="session-title"
          data-testid="session-title"
          onClick={() => {
            ui.show({ kind: 'session', id });
          }}
        >
          <span className="truncate">{title}</span>
          {session.pinned && (
            <span className="pin-mark" title={t('session.pinned')} data-testid="pin-mark">
              <PinIcon label={t('session.pinned')} />
            </span>
          )}
          {session.archived && <span className="tag">{t('session.archived')}</span>}
        </button>
      )}
      <MenuButton label={t('session.actions', { title })} items={items} testId="session-actions">
        ⋯
      </MenuButton>
      {menu.open !== null && (
        <MenuPopup
          items={items}
          at={menu.open}
          onClose={menu.close}
          label={t('session.actions', { title })}
        />
      )}
    </li>
  );
});
