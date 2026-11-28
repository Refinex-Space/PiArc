import { useId, useRef, useState, type ReactNode } from 'react';

import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { SessionTitleInput } from './SessionTitleInput.js';
import { useSession } from '../store/hooks.js';
import { badgeOf } from '../store/status.js';
import { chooseDetail, useSessionDetail } from '../transcript/detail.js';
import { DetailSwitch } from '../transcript/DetailSwitch.js';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, SidebarIcon } from './icons.js';
import { sessionTitle } from './SessionRow.js';
import { StatusBadge } from './StatusBadge.js';
import { useTitleChanges } from './title-change.js';
import { useUi } from './ui.js';

function SessionHeading({ id }: { readonly id: string }) {
  const t = useT();
  const session = useSession(id);
  const titleButton = useRef<HTMLButtonElement>(null);
  const detail = useSessionDetail(id);
  const popoverId = useId();
  const [renaming, setRenaming] = useState(false);
  const title = sessionTitle(session?.title, t('session.untitled'));
  const changes = useTitleChanges(title);
  // The tip names the whole title while it is cut off, and the action otherwise.
  const titleTooltip = (event: { readonly currentTarget: HTMLButtonElement }) => {
    const button = event.currentTarget;
    button.dataset.tooltip = button.scrollWidth > button.clientWidth ? title : t('session.rename');
  };
  return (
    <>
      {/* Running shows in the sidebar row and the working line; the title marks only what needs
          the user (an error, a pending approval). */}
      {session && badgeOf(session) !== 'idle' && badgeOf(session) !== 'running' && (
        <StatusBadge state={badgeOf(session)} />
      )}
      {renaming ? (
        <SessionTitleInput
          id={id}
          title={session?.title}
          trigger={titleButton}
          onClose={() => {
            setRenaming(false);
          }}
        />
      ) : (
        <h1 className="workbench-heading">
          <button
            type="button"
            className="workbench-title truncate"
            ref={titleButton}
            aria-label={t('session.rename') + ' · ' + title}
            data-tooltip={t('session.rename')}
            onPointerEnter={titleTooltip}
            onFocus={titleTooltip}
            onClick={() => {
              setRenaming(true);
            }}
            data-testid="conversation-title"
          >
            <span key={changes} className={changes > 0 ? 'title-in' : undefined}>
              {title}
            </span>
          </button>
        </h1>
      )}
      <div className="view-control">
        <IconButton
          label={t('transcript.view.label')}
          popoverTarget={popoverId}
          data-testid="session-view-options"
        >
          <ChevronDownIcon />
        </IconButton>
        <div id={popoverId} popover="auto" className="view-popover">
          <div className="view-caption">{t('transcript.view.label')}</div>
          <DetailSwitch
            value={detail}
            onChange={(next) => {
              chooseDetail(id, next);
            }}
          />
        </div>
      </div>
    </>
  );
}

export function WorkbenchHeader({
  sessionId,
  collapsed,
  history,
  children,
}: {
  readonly sessionId: string | undefined;
  readonly collapsed: boolean;
  readonly history: {
    readonly back: (() => void) | undefined;
    readonly forward: (() => void) | undefined;
  };
  readonly children: ReactNode;
}) {
  const t = useT();
  const ui = useUi();
  return (
    <header className={`titlebar main-titlebar workbench-header${sessionId ? ' has-session' : ''}`}>
      {collapsed && (
        <div className="history-buttons">
          <IconButton
            label={t('sidebar.expand')}
            onClick={ui.toggleSidebar}
            data-testid="expand-sidebar"
          >
            <SidebarIcon />
          </IconButton>
          <IconButton label={t('nav.back')} disabled={!history.back} onClick={history.back}>
            <ChevronLeftIcon />
          </IconButton>
          <IconButton
            label={t('nav.forward')}
            disabled={!history.forward}
            onClick={history.forward}
          >
            <ChevronRightIcon />
          </IconButton>
        </div>
      )}
      {sessionId ? (
        <SessionHeading key={sessionId} id={sessionId} />
      ) : (
        <h1 className="workbench-heading home-heading">{t('sidebar.newSession')}</h1>
      )}
      {/* The new-session view has its tools too (ADR-0099); they render nothing without use. */}
      <div className="header-tools">{children}</div>
    </header>
  );
}
