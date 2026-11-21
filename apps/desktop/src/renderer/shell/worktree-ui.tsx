// T35 parts of the main window: what links, dropped folders and second starts ask to open, and
// the question the worktree cleanup leaves for archived sessions with uncommitted changes.
import { useEffect } from 'react';

import type { LaunchTarget } from '../../shared/ipc.js';
import { useT } from '../app/app-context.js';
import { useSessions } from '../store/hooks.js';
import { sessionTitle } from './SessionRow.js';

/** Runs `open` for the targets waiting for this window, then for each one that arrives. */
export function useLaunchTargets(open: (target: LaunchTarget) => void): void {
  useEffect(() => {
    let active = true;
    const unsubscribe = window.piarc.onAppEvent((event) => {
      if (event.type === 'launch') open(event.target);
    });
    window.piarc.takeLaunchTargets().then(
      (targets) => {
        if (active) for (const target of targets) open(target);
      },
      (error: unknown) => {
        console.error('[shell] cannot read the launch targets', error);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open]);
}

/**
 * Drag-and-drop handlers that open a folder dropped on the window as a workspace. Files are
 * left to the composer (attachments); anything else dropped is ignored rather than navigated
 * to.
 */
export function folderDrop(open: (path: string) => void): {
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
} {
  return {
    onDragOver: (event) => {
      if (!event.defaultPrevented && event.dataTransfer.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    onDrop: (event) => {
      if (event.defaultPrevented) return;
      const items = [...event.dataTransfer.items];
      const folder = items.findIndex((item) => item.webkitGetAsEntry()?.isDirectory === true);
      const file = folder === -1 ? undefined : event.dataTransfer.files[folder];
      event.preventDefault();
      if (file === undefined) return;
      const path = window.piarc.pathForFile(file);
      if (path.length > 0) open(path);
    },
  };
}

/** Archived sessions whose worktree the cleanup found changed: remove it or keep it longer. */
export function WorktreeCleanupNotices() {
  const t = useT();
  const sessions = useSessions().filter((s) => s.worktreeConfirmCleanup && !s.worktreeRemoved);
  if (sessions.length === 0) return null;
  const report = (error: unknown) => {
    console.error('[shell] worktree cleanup answer failed', error);
  };
  return (
    <div className="notices" data-testid="worktree-cleanup">
      {sessions.map((session) => (
        <div key={session.id} className="notice" role="alert" data-session={session.id}>
          <span>
            {t('notice.cleanup', { title: sessionTitle(session.title, t('session.untitled')) })}
            {session.worktreePath === undefined ? null : (
              <code className="small"> {session.worktreePath}</code>
            )}
          </span>
          <button
            type="button"
            className="button button-small"
            data-testid="cleanup-remove"
            onClick={() => {
              window.piarc.removeSessionWorktree(session.id).catch(report);
            }}
          >
            {t('notice.cleanupRemove')}
          </button>
          <button
            type="button"
            className="button button-small"
            data-testid="cleanup-keep"
            onClick={() => {
              window.piarc.keepSessionWorktree(session.id).catch(report);
            }}
          >
            {t('notice.cleanupKeep')}
          </button>
        </div>
      ))}
    </div>
  );
}
