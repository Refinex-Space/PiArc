// The main window (architecture section 8.2): sidebar | conversation (including session rail) | session tools.
// Owns the window's presentation state (`ui.tsx`) and connects the store to Core's events.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { flushSync } from 'react-dom';

import type { AppCommand, LaunchTarget } from '../../shared/ipc.js';
import { parseComposerInfo, type ComposerInfo } from '../composer/attachments.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useApp } from '../app/app-context.js';
import { SettingsModal } from '../settings/SettingsModal.js';
import { AppStore } from '../store/app-store.js';
import { StoreConnection } from '../store/connection.js';
import { StoreContext, useHarnessOf, useSessionOf, useTasksOf } from '../store/hooks.js';
import { createTranscriptServices } from '../transcript/services.js';
import { Conversation } from './Conversation.js';
import { Home } from './Home.js';
import {
  clampSidebar,
  loadLayout,
  loadSidebarGroups,
  localStore,
  saveLayout,
  type Layout,
} from './layout.js';
import { NoticeBar } from './NoticeBar.js';
import { WorktreeCleanupNotices, folderDrop, useLaunchTargets } from './worktree-ui.js';
import { PageBoundary } from './PageBoundary.js';
import { RailArea } from './PanelAreas.js';
import { SessionTools, SessionTileWorkspace, WorkbenchPanels } from './WorkbenchPanels.js';
import type { PanelContext } from './registry.js';
import './harness-panels.js';
import './task-panels.js';
import './SideChat.js';
import '../changes/panels.js';
import '../terminal/panels.js';
import { requestFilesControl } from '../files/file-controls.js';
import { toggleChangesPanel } from '../changes/panel-state.js';
import { showPanel, togglePanel } from './registry.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { CommandPalette } from './CommandPalette.js';
import { requestCommand } from './command-requests.js';
import { Sidebar } from './Sidebar.js';
import { WorkbenchHeader } from './WorkbenchHeader.js';
import { useViewHistory } from './view-history.js';
import { groupSessions } from './Sidebar.js';
import { Toasts } from './Toasts.js';
import { TooltipLayer } from '../app/Tooltip.js';
import { TrustDialog, needsDecision, parseTrustView } from './TrustDialog.js';
import { UiContext, type Toast, type TrustMode, type Ui, type View } from './ui.js';
import { useAttention } from './use-attention.js';
import { useCommands } from './use-commands.js';

const RAIL_WIDTH = { min: 240, max: 560 } as const;

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
  const tasks = useTasksOf(store);
  const backgroundTasks =
    sessionId !== undefined && tasks.some((t) => t.ownerSessionId === sessionId);
  return useMemo(
    () => ({
      sessionId,
      tasks: (harness?.todos.length ?? 0) > 0,
      plan: harness?.plan !== undefined || pendingPlan === true,
      backgroundTasks,
    }),
    [sessionId, harness, pendingPlan, backgroundTasks],
  );
}

function isSettingsRoute(): boolean {
  return /^#\/settings(?:\/|$)/u.test(window.location.hash);
}

function Attention({ covered }: { readonly covered: boolean }) {
  useAttention(covered);
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
  const history = useViewHistory(
    (entry) => entry.kind === 'home' || store.session(entry.id) !== undefined,
  );
  const { view, visit: setView } = history;
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 699px)').matches);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 699px)');
    const update = () => {
      setNarrow(query.matches);
      setSidebarPeek(false);
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);
  const selected = view.kind === 'session' ? view.id : undefined;
  const [viewNonce, setViewNonce] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(localStore()));
  const collapsed = narrow ? !sidebarPeek : layout.sidebarCollapsed;
  const [trust, setTrust] = useState<TrustRequest | undefined>(undefined);
  const focusSidebarToggle = useRef(false);
  useEffect(() => {
    if (!focusSidebarToggle.current) return;
    const selector = collapsed
      ? '[data-testid="expand-sidebar"]'
      : '[data-testid="collapse-sidebar"]';
    document.querySelector<HTMLButtonElement>(selector)?.focus();
    focusSidebarToggle.current = false;
  }, [collapsed]);
  useEffect(() => {
    setSidebarPeek(false);
  }, [view]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsEntry, setSettingsEntry] = useState<number | null>(() =>
    isSettingsRoute() ? 0 : null,
  );
  const settingsOpen = settingsEntry !== null;
  const openSettings = useCallback((page?: string) => {
    if (page === undefined && isSettingsRoute()) {
      setSettingsEntry((current) => current ?? 0);
      return;
    }
    window.history.replaceState(null, '', page ? '#/settings/' + page : '#/settings');
    setSettingsEntry((current) => (current ?? -1) + 1);
  }, []);
  const closeSettings = useCallback(() => {
    if (isSettingsRoute())
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setSettingsEntry(null);
  }, []);
  useEffect(() => {
    const sync = () => {
      setSettingsEntry((current) => (isSettingsRoute() ? (current ?? 0) : null));
    };
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
    };
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const dismissPalette = () => {
    // Commands can immediately focus a workbench control. Release its inert ancestor first.
    flushSync(() => {
      setPaletteOpen(false);
    });
    if (paletteOpener.current?.isConnected) paletteOpener.current.focus({ preventScroll: true });
    paletteOpener.current = null;
  };
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
          closeSettings();
          setView({ kind: 'session', id: event.sessionId });
        }
      }),
    [closeSettings, setView],
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
    [store, setView],
  );

  const show = useCallback(
    (next: View) => {
      setView(next);
      setSidebarPeek(false);
      setViewNonce((n) => n + 1);
    },
    [setView],
  );

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
  const openPath = useCallback(
    async (path: string): Promise<string> => {
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
        current.kind === 'home' && current.workspace === canonical
          ? current
          : { kind: 'home', workspace: canonical },
      );
      setSidebarPeek(false);
      return canonical;
    },
    [setView],
  );

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
      if (target.kind === 'settings') {
        openSettings(target.page);
        return;
      }
      closeSettings();
      if (target.kind === 'session') {
        show({ kind: 'session', id: target.sessionId });
        return;
      }
      if (target.kind === 'newSession') {
        show({ kind: 'home', workspace: undefined });
        return;
      }
      const opened = target.kind === 'chooseFolder' ? openFolder() : openPath(target.path);
      opened
        .then(async (workspace) => {
          if (workspace === undefined) return;
          const proceed = await ensureTrust(workspace, 'decide');
          if (proceed && target.kind === 'draft') {
            show({ kind: 'home', workspace, draft: target.text });
          }
        })
        .catch((error: unknown) => {
          console.error('[shell] cannot open the launch target', error);
        });
    },
    [show, ensureTrust, openFolder, openPath, openSettings, closeSettings],
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
    focusSidebarToggle.current = true;
    if (narrow) setSidebarPeek((current) => !current);
    else setLayout((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
  }, [narrow]);

  const runRef = useRef<(command: AppCommand) => void>(() => undefined);
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
      runCommand: (command) => {
        runRef.current(command);
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
    if (settingsOpen) {
      if (
        command === 'session.close' &&
        !document.querySelector('.settings-dialog [role="dialog"]')
      )
        closeSettings();
      return;
    }
    if (trust || document.querySelector('[data-testid="workspace-search"]')) return;
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
      case 'files.toggle':
        if (selected) togglePanel('files');
        break;
      case 'files.quick':
      case 'files.tree':
        if (selected) {
          showPanel('files');
          requestFilesControl(selected, command === 'files.quick' ? 'search' : 'tree');
        }
        break;
      case 'session.sideChat':
        if (selected && !shortcutsOpen) {
          showPanel('side-chat');
        }
        break;
      case 'session.model':
        if (!shortcutsOpen) modelButton.current?.click();
        break;
      case 'session.effort':
        if (!shortcutsOpen) effortButton.current?.click();
        break;
      case 'session.permissionMode':
        if (!shortcutsOpen) modeButton.current?.click();
        break;
      case 'session.next': {
        const order = groupSessions(
          store.workspaces(),
          store.sessions(),
          '',
          false,
          '',
          loadSidebarGroups().order,
        ).flatMap((g) => g.sessions.map((s) => s.id));
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
      case 'app.commandPalette':
        if (!shortcutsOpen) {
          paletteOpener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setPaletteOpen(true);
        }
        break;
      case 'changes.toggle':
        if (selected) toggleChangesPanel();
        break;
      case 'terminal.toggle':
        if (selected) togglePanel('terminal');
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
  const dispatch = (command: AppCommand) => {
    if (paletteOpen) {
      if (command === 'app.commandPalette' || command === 'session.close') dismissPalette();
      return;
    }
    run(command);
  };
  runRef.current = dispatch;
  useCommands(dispatch);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
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
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const context = usePanelContext(store, selected);
  return (
    <StoreContext.Provider value={store}>
      <UiContext.Provider value={ui}>
        <Attention covered={settingsOpen} />
        <div
          className={`shell${collapsed ? ' is-collapsed' : ''}`}
          data-testid="app-shell"
          inert={Boolean(trust) || shortcutsOpen || paletteOpen}
          onKeyDown={(event) => {
            if (
              sidebarPeek &&
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !isImeComposing(event.nativeEvent)
            ) {
              event.preventDefault();
              toggleSidebar();
            }
          }}
          onDragOver={drop.onDragOver}
          onDrop={drop.onDrop}
          style={
            { '--piarc-sidebar-width': `${String(layout.sidebarWidth)}px` } as React.CSSProperties
          }
        >
          {!collapsed && (
            <Sidebar
              history={history}
              resizer={
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
              }
            />
          )}
          {narrow && sidebarPeek && (
            <button
              type="button"
              className="sidebar-backdrop"
              tabIndex={-1}
              aria-label={t('sidebar.collapse')}
              onClick={toggleSidebar}
            />
          )}
          <div className="workspace-area" inert={narrow && sidebarPeek}>
            <WorkbenchPanels context={context}>
              <SessionTileWorkspace context={context}>
                <WorkbenchHeader sessionId={selected} collapsed={collapsed} history={history}>
                  <SessionTools context={context} />
                </WorkbenchHeader>
                <div className="main-row">
                  <main className="main" data-testid="shell-main">
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
                          covered={settingsOpen}
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
                    min={RAIL_WIDTH.min}
                    max={RAIL_WIDTH.max}
                    onResize={(size) => {
                      setLayout((current) => ({
                        ...current,
                        railWidth: Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, size)),
                      }));
                    }}
                  />
                </div>
              </SessionTileWorkspace>
            </WorkbenchPanels>
          </div>
        </div>
        <Toasts />
        <TooltipLayer />
        {paletteOpen && (
          <CommandPalette
            current={
              view.kind === 'session'
                ? {
                    id: view.id,
                    workspace: store.session(view.id)?.workspace,
                    cwd: store.session(view.id)?.cwd,
                  }
                : undefined
            }
            run={run}
            open={(id) => {
              show({ kind: 'session', id });
            }}
            command={(name) => {
              if (view.kind === 'session') requestCommand(view.id, name);
            }}
            onClose={dismissPalette}
          />
        )}
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
        {settingsEntry !== null && <SettingsModal entry={settingsEntry} onClose={closeSettings} />}
      </UiContext.Provider>
    </StoreContext.Provider>
  );
}
