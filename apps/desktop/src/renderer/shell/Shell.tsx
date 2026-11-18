// The main window (architecture section 8.2): sidebar | main area (+ right rail) over the dock.
// Owns the window's presentation state (`ui.tsx`) and connects the store to Core's events.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AppCommand } from '../../shared/ipc.js';
import { parseComposerInfo, type ComposerInfo } from '../composer/attachments.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useApp } from '../app/app-context.js';
import { AppStore } from '../store/app-store.js';
import { StoreConnection } from '../store/connection.js';
import { StoreContext } from '../store/hooks.js';
import { createTranscriptServices } from '../transcript/services.js';
import { Conversation } from './Conversation.js';
import { Home } from './Home.js';
import { clampSidebar, loadLayout, localStore, saveLayout, type Layout } from './layout.js';
import { NoticeBar } from './NoticeBar.js';
import { DockArea, RailArea } from './PanelAreas.js';
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

  const openFolder = useCallback(async (): Promise<string | undefined> => {
    const path = await window.piarc.chooseFolder();
    if (path === null) {
      return undefined;
    }
    const opened: unknown = JSON.parse(await window.piarc.openWorkspace(path));
    const canonical =
      typeof opened === 'object' &&
      opened !== null &&
      typeof (opened as { path?: unknown }).path === 'string'
        ? (opened as { path: string }).path
        : path;
    show({ kind: 'home', workspace: canonical });
    return canonical;
  }, [show]);

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
  const context = { sessionId: view.kind === 'session' ? view.id : undefined };
  return (
    <StoreContext.Provider value={store}>
      <UiContext.Provider value={ui}>
        <Attention />
        <div
          className={`shell${layout.sidebarCollapsed ? ' is-collapsed' : ''}`}
          data-testid="app-shell"
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
                {view.kind === 'home' ? (
                  <Home
                    key={viewNonce}
                    workspace={view.workspace}
                    draft={view.draft}
                    failure={view.error}
                  />
                ) : (
                  <Conversation key={view.id} id={view.id} />
                )}
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
