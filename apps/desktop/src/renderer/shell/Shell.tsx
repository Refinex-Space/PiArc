// The main window (architecture section 8.2): sidebar | main area (+ right rail) over the dock.
// Owns the window's presentation state (`ui.tsx`) and connects the store to Core's events.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AppCommand, LaunchTarget } from '../../shared/ipc.js';
import { parseComposerInfo, type ComposerInfo } from '../composer/attachments.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useApp } from '../app/app-context.js';
import { AppStore } from '../store/app-store.js';
import { StoreConnection } from '../store/connection.js';
import { StoreContext, useHarnessOf, useSessionOf, useTasksOf } from '../store/hooks.js';
import { createTranscriptServices } from '../transcript/services.js';
import { Conversation } from './Conversation.js';
import { Home } from './Home.js';
import { clampSidebar, loadLayout, localStore, saveLayout, type Layout } from './layout.js';
import { NoticeBar } from './NoticeBar.js';
import { WorktreeCleanupNotices, folderDrop, useLaunchTargets } from './worktree-ui.js';
import { PageBoundary } from './PageBoundary.js';
import { DockArea, RailArea } from './PanelAreas.js';
import type { PanelContext } from './registry.js';
import './harness-panels.js';
import './task-panels.js';
import '../changes/panels.js';
import '../terminal/panels.js';
import { toggleTerminalPanel, useTerminalPanelOpen } from '../terminal/panel-state.js';
import { toggleChangesPanel, useChangesPanelOpen } from '../changes/panel-state.js';
import { showPanel } from './registry.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { Sidebar } from './Sidebar.js';
import { groupSessions } from './Sidebar.js';
import { Toasts } from './Toasts.js';
import { TrustDialog, needsDecision, parseTrustView } from './TrustDialog.js';
import { UiContext, type Toast, type TrustMode, type Ui, type View } from './ui.js';
import { useAttention } from './use-attention.js';
import { useCommands } from './use-commands.js';

interface TrustRequest {
  readonly workspace: string;
  readonly mode: TrustMode;
  readonly resolve: (proceed: boolean) => void;
}

/** What the panels show about: the selected session and whether it has a task list or a plan. */
function usePanelContext(store: AppStore, sessionId: string | undefined): PanelContext {
  const harness = useHarnessOf(store, sessionId);
  const session = useSessionOf(store, sessionId);
  const pendingPlan = session?.approvals.some((r) => r.kind === 'plan');
  const changes = useChangesPanelOpen();
  const terminal = useTerminalPanelOpen();
  const tasks = useTasksOf(store);
  const backgroundTasks =
    sessionId !== undefined && tasks.some((t) => t.ownerSessionId === sessionId);
  const workspaceTasks =
    session !== undefined && tasks.some((t) => t.workspace === session.workspace);
  return useMemo(
    () => ({
      sessionId,
      tasks: (harness?.todos.length ?? 0) > 0,
      plan: harness?.plan !== undefined || pendingPlan === true,
      changes,
      backgroundTasks,
      workspaceTasks,
      terminal,
    }),
    [sessionId, harness, pendingPlan, changes, backgroundTasks, workspaceTasks, terminal],
  );
}

function Attention() {
  useAttention();
  return null;
}

export function Shell() {
  const { t } = useApp();
  const store = useMemo(() => new AppStore(), []);
  const connection = useMemo(() => new StoreConnection(store, window.piarc), [store]);
  const transcriptServices = useMemo(() => createTranscriptServices(null), []);
  // The streaming driver follows every session's transcript, shown or not.
  useEffect(() => {
    const stops: (() => void)[] = [];
    const stop = store.onTranscript((transcript) => {
      stops.push(transcriptServices.driver.follow(transcript));
    });
    return () => {
      stop();
      for (const each of stops) {
        each();
      }
    };
  }, [store, transcriptServices]);
  const watched = useRef(new Set<string>());
  const watchSession = useCallback(
    (id: string) => {
      if (!watched.current.has(id)) {
        watched.current.add(id);
        connection.watchSession(id);
      }
    },
    [connection],
  );
  const [composer, setComposer] = useState<ComposerInfo | undefined>(undefined);
  useEffect(() => {
    window.piarc.composerInfo().then(
      (text) => {
        setComposer(parseComposerInfo(text));
      },
      (error: unknown) => {
        console.error('[shell] cannot read the composer configuration', error);
      },
    );
  }, []);
  const [view, setView] = useState<View>({ kind: 'home', workspace: undefined });
  const [viewNonce, setViewNonce] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(localStore()));
  const [trust, setTrust] = useState<TrustRequest | undefined>(undefined);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    connection.start().catch((error: unknown) => {
      console.error('[shell] cannot connect to Core events', error);
    });
  }, [connection]);
  useEffect(() => {
    saveLayout(localStore(), layout);
  }, [layout]);
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'openSession') {
          setView({ kind: 'session', id: event.sessionId });
        }
      }),
    [],
  );
  // A session that disappears (deleted, archived elsewhere) leaves the main area. A session
  // just created may not be in the list yet: only one that was listed can disappear.
  const listedRef = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      store.subscribeSessions(() => {
        const current = viewRef.current;
        if (current.kind !== 'session') {
          return;
        }
        if (store.session(current.id) !== undefined) {
          listedRef.current = current.id;
        } else if (listedRef.current === current.id) {
          listedRef.current = undefined;
          setView({ kind: 'home', workspace: undefined });
        }
      }),
    [store],
  );

  const show = useCallback((next: View) => {
    setView(next);
    setViewNonce((n) => n + 1);
  }, []);

  const ensureTrust = useCallback(async (workspace: string, mode: TrustMode): Promise<boolean> => {
    if (mode === 'decide') {
      const view = parseTrustView(await window.piarc.projectTrust(workspace));
      if (view !== undefined && !needsDecision(view)) {
        return true;
      }
    }
    return new Promise<boolean>((resolve) => {
      setTrust({ workspace, mode, resolve });
    });
  }, []);

  /** Opens `path` as a workspace and shows its home view; resolves Core's spelling of it. */
  const openPath = useCallback(async (path: string): Promise<string> => {
    const opened: unknown = JSON.parse(await window.piarc.openWorkspace(path));
    const canonical =
      typeof opened === 'object' &&
      opened !== null &&
      typeof (opened as { path?: unknown }).path === 'string'
        ? (opened as { path: string }).path
        : path;
    // Core lists the folder before opening finishes and the home view shows it then: keep a
    // home view the user may be typing in (no remount), and switch any other view to home.
    setView((current) =>
      current.kind === 'home'
        ? { ...current, workspace: canonical }
        : { kind: 'home', workspace: canonical },
    );
    return canonical;
  }, []);

  const openFolder = useCallback(async (): Promise<string | undefined> => {
    const path = await window.piarc.chooseFolder();
    if (path === null) {
      return undefined;
    }
    return openPath(path);
  }, [openPath]);

  // T35: a link, a dropped folder or a second start. A folder opens as a workspace and, when it
  // is not trusted yet, the trust dialog shows as for any folder; a session is shown.
  const launch = useCallback(
    (target: LaunchTarget) => {
      if (target.kind === 'session') {
        show({ kind: 'session', id: target.sessionId });
        return;
      }
      openPath(target.path).then(
        (opened) => ensureTrust(opened, 'decide'),
        (error: unknown) => {
          console.error('[shell] cannot open the folder', error);
        },
      );
    },
    [show, ensureTrust, openPath],
  );
  useLaunchTargets(launch);
  const drop = useMemo(
    () =>
      folderDrop((path) => {
        launch({ kind: 'workspace', path });
      }),
    [launch],
  );

  const toggleSidebar = useCallback(() => {
    setLayout((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
  }, []);

  const ui = useMemo<Ui>(
    () => ({
      view,
      show,
      connection,
      watchSession,
      transcriptServices,
      composer,
      ensureTrust,
      openFolder,
      toggleSidebar,
      openShortcuts: () => {
        setShortcutsOpen(true);
      },
      toasts,
      addToast: (toast) => {
        setToasts((list) => [...list.slice(-3), { ...toast, id: crypto.randomUUID() }]);
      },
      dismissToast: (id) => {
        setToasts((list) => list.filter((toast) => toast.id !== id));
      },
    }),
    [
      view,
      show,
      connection,
      watchSession,
      transcriptServices,
      composer,
      ensureTrust,
      openFolder,
      toggleSidebar,
      toasts,
    ],
  );

  const modelButton = useRef<HTMLButtonElement>(null);
  const effortButton = useRef<HTMLButtonElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const run = (command: AppCommand) => {
    switch (command) {
      case 'session.new':
        show({
          kind: 'home',
          workspace: view.kind === 'session' ? store.session(view.id)?.workspace : view.workspace,
        });
        break;
      case 'session.close': {
        if (view.kind !== 'session') {
          break;
        }
        const session = store.session(view.id);
        show({ kind: 'home', workspace: session?.workspace });
        if (session?.open === true && session.status !== 'running') {
          window.piarc.closeSession(view.id).catch((error: unknown) => {
            console.error('[shell] cannot close the session', error);
          });
        }
        break;
      }
      case 'session.model':
        if (!trust && !shortcutsOpen) modelButton.current?.click();
        break;
      case 'session.effort':
        if (!trust && !shortcutsOpen) effortButton.current?.click();
        break;
      case 'session.permissionMode':
        if (!trust && !shortcutsOpen) modeButton.current?.click();
        break;
      case 'session.next': {
        const order = groupSessions(store.workspaces(), store.sessions(), '', false, '').flatMap(
          (g) => g.sessions.map((s) => s.id),
        );
        if (order.length === 0) {
          break;
        }
        const at = view.kind === 'session' ? order.indexOf(view.id) : -1;
        const next = order[(at + 1) % order.length];
        if (next !== undefined) {
          show({ kind: 'session', id: next });
        }
        break;
      }
      case 'help.shortcuts':
        setShortcutsOpen(true);
        break;
      case 'changes.toggle':
        if (view.kind === 'session' && toggleChangesPanel()) showPanel('changes');
        break;
      case 'terminal.toggle':
        if (view.kind === 'session' && toggleTerminalPanel()) showPanel('terminal');
        break;
      case 'app.settings':
        void window.piarc.openSettings();
        break;
      case 'workspace.openFolder':
        void openFolder();
        break;
      case 'view.toggleSidebar':
        toggleSidebar();
        break;
    }
  };
  useCommands(run);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const from = layout.sidebarWidth;
    const move = (moveEvent: PointerEvent) => {
      setLayout((current) => ({
        ...current,
        sidebarWidth: clampSidebar(from + moveEvent.clientX - start),
      }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const context = usePanelContext(store, view.kind === 'session' ? view.id : undefined);
  return (
    <StoreContext.Provider value={store}>
      <UiContext.Provider value={ui}>
        <Attention />
        <div
          className={`shell${layout.sidebarCollapsed ? ' is-collapsed' : ''}`}
          data-testid="app-shell"
          onDragOver={drop.onDragOver}
          onDrop={drop.onDrop}
          style={
            { '--piarc-sidebar-width': `${String(layout.sidebarWidth)}px` } as React.CSSProperties
          }
        >
          {!layout.sidebarCollapsed && (
            <>
              <Sidebar />
              <div
                className="resizer resizer-x sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('sidebar.resize')}
                aria-valuemin={200}
                aria-valuemax={420}
                aria-valuenow={layout.sidebarWidth}
                tabIndex={0}
                data-testid="sidebar-resizer"
                onPointerDown={startResize}
                onDoubleClick={() => {
                  setLayout((current) => ({
                    ...current,
                    sidebarWidth: loadLayout(undefined).sidebarWidth,
                  }));
                }}
                onKeyDown={(event) => {
                  if (isImeComposing(event.nativeEvent)) {
                    return;
                  }
                  const step =
                    event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
                  if (step !== 0) {
                    event.preventDefault();
                    setLayout((current) => ({
                      ...current,
                      sidebarWidth: clampSidebar(current.sidebarWidth + step),
                    }));
                  }
                }}
              />
            </>
          )}
          <div className="workspace-area">
            <div className="main-row">
              <main className="main" data-testid="shell-main">
                {layout.sidebarCollapsed && (
                  <button
                    type="button"
                    className="icon-button expand-sidebar"
                    aria-label={t('sidebar.expand')}
                    title={t('sidebar.expand')}
                    data-testid="expand-sidebar"
                    onClick={toggleSidebar}
                  >
                    ☰
                  </button>
                )}
                <NoticeBar />
                <WorktreeCleanupNotices />
                <PageBoundary
                  key={view.kind === 'home' ? `home:${String(viewNonce)}` : view.id}
                  message={t('shell.pageFailed')}
                >
                  {view.kind === 'home' ? (
                    <Home workspace={view.workspace} draft={view.draft} failure={view.error} />
                  ) : (
                    <Conversation
                      id={view.id}
                      modeButton={modeButton}
                      modelButton={modelButton}
                      effortButton={effortButton}
                    />
                  )}
                </PageBoundary>
              </main>
              <RailArea
                context={context}
                size={layout.railWidth}
                onResize={(size) => {
                  setLayout((current) => ({
                    ...current,
                    railWidth: Math.min(560, Math.max(240, size)),
                  }));
                }}
              />
            </div>
            <DockArea
              context={context}
              size={layout.dockHeight}
              onResize={(size) => {
                setLayout((current) => ({
                  ...current,
                  dockHeight: Math.min(800, Math.max(120, size)),
                }));
              }}
            />
          </div>
        </div>
        <Toasts />
        {shortcutsOpen && (
          <ShortcutsDialog
            onClose={() => {
              setShortcutsOpen(false);
            }}
          />
        )}
        {trust !== undefined && (
          <TrustDialog
            workspace={trust.workspace}
            mode={trust.mode}
            onDone={(decided) => {
              setTrust(undefined);
              trust.resolve(decided !== undefined);
            }}
          />
        )}
      </UiContext.Provider>
    </StoreContext.Provider>
  );
}
