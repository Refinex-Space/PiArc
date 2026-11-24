// Open tools belong to the selected session. Rearranging or expanding them is local to ToolTiles.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { requestTerminalFocus } from '../terminal/panel-state.js';
import {
  ChangesIcon,
  FolderIcon,
  MoreIcon,
  PreviewIcon,
  RailIcon,
  SideChatIcon,
  TasksIcon,
  TerminalIcon,
} from './icons.js';
import { MenuPopup, useMenu, type MenuItem } from './Menu.js';
import {
  onPanelRequest,
  panelsFor,
  togglePanel,
  usePanels,
  type PanelContext,
} from './registry.js';
import { ToolTiles } from './ToolTiles.js';
import './planned-panels.js';

interface Presentation {
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  setCompact: (compact: boolean) => void;
  openIds: readonly string[];
  closePanel: (id: string) => void;
}

const PresentationContext = createContext<Presentation | null>(null);

export function usePanelPresentation(): Presentation {
  const value = useContext(PresentationContext);
  if (!value) throw new Error('Panel control outside WorkbenchPanels');
  return value;
}

function storageKey(session: string): string {
  return 'piarc.tools.open.' + session;
}

function restoreOpenIds(session: string | undefined): string[] {
  if (!session) return [];
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(session)) ?? 'null');
    if (Array.isArray(value))
      return [
        ...new Set(value.filter((v): v is string => typeof v === 'string' && v !== 'side-chat')),
      ];
    return sessionStorage.getItem('piarc.terminal.open') === 'true' ? ['terminal'] : [];
  } catch {
    return [];
  }
}

interface PanelProps {
  readonly context: PanelContext;
  readonly children: ReactNode;
}

export function WorkbenchPanels(props: PanelProps) {
  return <SessionPanels key={props.context.sessionId ?? ''} {...props} />;
}

function SessionPanels({ context, children }: PanelProps) {
  const registered = usePanels();
  const [ids, setIds] = useState(() => restoreOpenIds(context.sessionId));
  const open = useRef(ids);
  const origins = useRef(new Map<string, WeakRef<HTMLElement>>());
  const [compact, setCompactMode] = useState(false);
  const [wideRail, setWideRail] = useState(true);
  const [overlayRail, setOverlayRail] = useState(false);
  const setCompact = useCallback((next: boolean) => {
    setCompactMode(next);
    setOverlayRail(false);
  }, []);
  const setRailOpen = compact ? setOverlayRail : setWideRail;
  const update = (next: string[]) => {
    open.current = next;
    setIds(next);
  };
  const closePanel = useCallback((id: string) => {
    if (!open.current.includes(id)) return;
    update(open.current.filter((p) => p !== id));
    const source = origins.current.get(id)?.deref();
    origins.current.delete(id);
    requestAnimationFrame(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="tool-' + id + '"]');
      const fallback = button ?? document.querySelector<HTMLElement>('[data-testid="tool-more"]');
      const target = source?.isConnected && source.getClientRects().length ? source : fallback;
      (target ?? document.querySelector<HTMLElement>('.composer-editor'))?.focus();
    });
  }, []);
  useEffect(() => {
    if (!context.sessionId) return;
    try {
      const persistent = ids.filter((id) => id !== 'side-chat');
      if (persistent.length)
        sessionStorage.setItem(storageKey(context.sessionId), JSON.stringify(persistent));
      else sessionStorage.removeItem(storageKey(context.sessionId));
      sessionStorage.removeItem('piarc.terminal.open');
    } catch {
      // Storage is a convenience; the window still owns its open tools.
    }
  }, [context.sessionId, ids]);
  useLayoutEffect(
    () =>
      onPanelRequest((request) => {
        if (!context.sessionId) return;
        const spec = registered.find((p) => p.id === request.id);
        if (!spec) return;
        if (spec.area === 'rail') {
          setRailOpen(true);
          return;
        }
        const already = open.current.includes(spec.id);
        if (request.action === 'toggle' && already) {
          closePanel(spec.id);
          return;
        }
        if (request.opener) origins.current.set(spec.id, request.opener);
        if (spec.id === 'terminal')
          requestTerminalFocus(context.sessionId, request.action === 'toggle' && !already);
        if (!already) update([...open.current, spec.id]);
      }),
    [context.sessionId, registered, closePanel, setRailOpen],
  );
  return (
    <PresentationContext.Provider
      value={{
        railOpen: compact ? overlayRail : wideRail,
        setRailOpen,
        setCompact,
        openIds: ids,
        closePanel,
      }}
    >
      {children}
    </PresentationContext.Provider>
  );
}

export function SessionTileWorkspace({ context, children }: PanelProps) {
  const t = useT();
  const { openIds, closePanel, setCompact } = usePanelPresentation();
  const specs = panelsFor(usePanels(), 'tool', context);
  const visible = openIds.filter((id) => specs.some((p) => p.id === id));
  const primary = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = primary.current;
    if (!node) return;
    let compact: boolean | undefined;
    const measure = () => {
      if (!node.clientWidth) return;
      const next = node.clientWidth < 660;
      if (next !== compact) {
        compact = next;
        setCompact(next);
      }
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    return () => {
      resize.disconnect();
    };
  }, [setCompact]);
  const specFor = (id: string) => specs.find((p) => p.id === id);
  return (
    <ToolTiles
      sessionId={context.sessionId}
      openIds={visible}
      titleOf={(id) => t(specFor(id)?.title ?? 'tiles.chat')}
      onClose={closePanel}
      renderPanel={(id) =>
        specFor(id)?.render(
          id === 'side-chat'
            ? {
                ...context,
                sideChat: {
                  close: () => {
                    closePanel(id);
                  },
                },
              }
            : context,
        )
      }
    >
      <div className="workspace-primary-frame" ref={primary}>
        {children}
      </div>
    </ToolTiles>
  );
}

export function SessionTools({ context }: { context: PanelContext }) {
  const t = useT();
  const menu = useMenu();
  const { railOpen, setRailOpen, openIds } = usePanelPresentation();
  if (!context.sessionId) return null;
  const controls = [
    ['terminal', 'panel.terminal', <TerminalIcon />],
    ['changes', 'panel.changes', <ChangesIcon />],
    ['preview', 'tiles.preview', <PreviewIcon />],
    ['files', 'tiles.files', <FolderIcon />],
  ] as const;
  const names = [
    ['side-chat', 'sideChat.title', <SideChatIcon />],
    ['background-tasks', 'panel.backgroundTasks', <TasksIcon />],
    ...(context.plan ? [['plan', 'panel.plan', <ChangesIcon />] as const] : []),
  ] as const;
  const items: MenuItem[] = names.map(([id, label, icon]) => ({
    id,
    testId: 'tool-' + id,
    label: t(label),
    icon,
    selected: openIds.includes(id),
    run: () => {
      togglePanel(id);
    },
  }));
  return (
    <div className="session-tools" role="group" aria-label={t('panels.tools')}>
      <IconButton
        label={t('panels.rail')}
        data-testid="tool-rail"
        aria-pressed={railOpen}
        aria-controls={railOpen ? 'session-rail' : undefined}
        onClick={() => {
          setRailOpen(!railOpen);
        }}
      >
        <RailIcon />
      </IconButton>
      {controls.map(([id, label, icon]) => (
        <IconButton
          key={id}
          label={t(label)}
          data-testid={'tool-' + id}
          aria-pressed={openIds.includes(id)}
          onClick={() => {
            togglePanel(id);
          }}
        >
          {icon}
        </IconButton>
      ))}
      <IconButton
        data-testid="tool-more"
        label={t('nav.more')}
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          menu.openAt(b.left, b.bottom + 4);
        }}
      >
        <MoreIcon />
      </IconButton>
      {menu.open && (
        <MenuPopup at={menu.open} items={items} label={t('panels.tools')} onClose={menu.close} />
      )}
    </div>
  );
}
