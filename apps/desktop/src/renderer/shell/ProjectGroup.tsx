import { useId, useState } from 'react';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import type { SessionEntry } from '../store/snapshots.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { DisclosureIcon, MoreIcon, PlusIcon } from './icons.js';
import { MenuPopup, useMenu, type MenuItem } from './Menu.js';
import { SessionRow } from './SessionRow.js';
import { useUi } from './ui.js';

export interface ProjectSessions {
  readonly path: string;
  readonly name: string;
  readonly sessions: readonly SessionEntry[];
}

export function ProjectGroup({
  group,
  closed,
  onToggle,
  onMove,
  first,
  last,
  dragging,
  dragStart,
  dragEnd,
  drop,
}: {
  group: ProjectSessions;
  closed: boolean;
  onToggle: () => void;
  onMove: (step: number) => void;
  first: boolean;
  last: boolean;
  dragging: 'source' | 'before' | 'after' | null;
  dragStart: () => void;
  dragEnd: () => void;
  drop: () => void;
}) {
  const t = useT();
  const ui = useUi();
  const menu = useMenu();
  const listId = useId();
  const [dropTarget, setDropTarget] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const expanded = group.sessions.length ? !closed : emptyOpen;
  const start = () => {
    ui.show({ kind: 'home', workspace: group.path });
  };
  const items: MenuItem[] = [
    { id: 'new-session', label: t('workspace.newSession', { name: group.name }), run: start },
    {
      id: 'trust',
      label: t('workspace.trust'),
      run: () => {
        void ui.ensureTrust(group.path, 'review');
      },
    },
    {
      id: 'move-up',
      label: t('nav.moveUp'),
      disabled: first,
      run: () => {
        onMove(-1);
      },
    },
    {
      id: 'move-down',
      label: t('nav.moveDown'),
      disabled: last,
      run: () => {
        onMove(1);
      },
    },
  ];
  return (
    <section
      className="workspace-group"
      data-testid="workspace-group"
      data-path={group.path}
      data-drop-target={dropTarget && dragging !== 'source' ? dragging : undefined}
      onDragOver={(event) => {
        if (dragging === null || dragging === 'source') return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDropTarget(false);
      }}
      onDrop={(event) => {
        if (dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(false);
        drop();
      }}
    >
      <header
        className="workspace-header"
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector('button')?.focus();
          menu.openAt(event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) return;
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              menu.openAt(rect.left, rect.bottom);
            }
          }}
          className="project-toggle"
          title={group.path}
          aria-expanded={expanded}
          aria-controls={listId}
          data-testid="project-toggle"
          draggable={!first || !last}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            // Internal drags carry no filesystem path; external drops still use the shell handler.
            event.dataTransfer.setData('application/x-piarc-project', 'move');
            dragStart();
          }}
          onDragEnd={dragEnd}
          onClick={() => {
            if (group.sessions.length) onToggle();
            else setEmptyOpen(!emptyOpen);
          }}
        >
          <span className="truncate">{group.name}</span>
          <DisclosureIcon />
        </button>
        <IconButton
          label={t('workspace.actions', { name: group.name })}
          data-testid="workspace-actions"
          className="project-more"
          aria-haspopup="menu"
          aria-expanded={menu.open !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            menu.openAt(rect.left, rect.bottom);
          }}
        >
          <MoreIcon />
        </IconButton>
        <IconButton
          label={t('workspace.newSession', { name: group.name })}
          onClick={start}
          data-testid="project-new"
        >
          <PlusIcon />
        </IconButton>
      </header>
      <div id={listId} hidden={!expanded}>
        {expanded &&
          (group.sessions.length > 0 ? (
            <ul className="interactive-list session-list">
              {group.sessions.map((session) => (
                <SessionRow key={session.id} id={session.id} />
              ))}
            </ul>
          ) : (
            <p className="workspace-empty muted small">{t('sidebar.workspaceEmpty')}</p>
          ))}
      </div>
      {menu.open && (
        <MenuPopup
          at={menu.open}
          onClose={menu.close}
          label={t('workspace.actions', { name: group.name })}
          items={items}
        />
      )}
    </section>
  );
}
