// Window presentation state. Receiving a Core task snapshot makes a panel available; only a
// user's action (or an explicit request such as a plan approval) brings it into the dock.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { openChangesPanel } from '../changes/panel-state.js';
import { setTerminalPanelOpen } from '../terminal/panel-state.js';
import { ChangesIcon, RailIcon, SideChatIcon, TasksIcon, TerminalIcon } from './icons.js';
import {
  panelsFor,
  showPanel,
  usePanels,
  useRequestedPanel,
  type PanelContext,
} from './registry.js';
import { useUi } from './ui.js';

interface PanelPresentation {
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  dockId: string | undefined;
  closeDock: () => void;
}
const Presentation = createContext<PanelPresentation | null>(null);

export function usePanelPresentation(): PanelPresentation {
  const value = useContext(Presentation);
  if (!value) throw new Error('Panel control outside WorkbenchPanels');
  return value;
}

export function WorkbenchPanels({
  context,
  children,
}: {
  context: PanelContext;
  children: ReactNode;
}) {
  const panels = usePanels();
  const request = useRequestedPanel();
  const handled = useRef(request);
  const opener = useRef<WeakRef<HTMLElement>>(undefined);
  const [railOpen, setRailOpen] = useState(() => !window.matchMedia('(max-width: 860px)').matches);
  const [chosen, setChosen] = useState<{ sessionId: string | undefined; id: string }>();
  const available = panelsFor(panels, 'dock', context);
  const selected =
    chosen?.sessionId === context.sessionId && available.some((p) => p.id === chosen?.id)
      ? chosen?.id
      : undefined;
  // A terminal deliberately left open survives a renderer reload. Side chat remains mounted
  // across dock tabs so that an unfinished reply stays attached to its original conversation.
  const incoming =
    request !== handled.current && available.some((panel) => panel.id === request?.id)
      ? request?.id
      : undefined;
  const dockId =
    incoming ??
    selected ??
    (context.terminal && context.sessionId
      ? 'terminal'
      : context.changes && context.sessionId
        ? 'changes'
        : undefined);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const change = () => {
      setRailOpen(!media.matches);
    };
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
    };
  }, []);
  useEffect(() => {
    if (!request || handled.current === request) return;
    const panel = panels.find((p) => p.id === request.id);
    if (!panel || (panel.when && !panel.when(context))) return;
    handled.current = request;
    if (panel.area === 'rail') setRailOpen(true);
    else {
      const target = request.opener?.deref();
      if (target && !target.closest('.workbench-dock')) opener.current = request.opener;
      setChosen({ sessionId: context.sessionId, id: panel.id });
    }
  }, [request, panels, context]);
  useEffect(() => {
    // Plan approval removal and the approved harness snapshot arrive separately.
    // Availability may lapse briefly; only navigation or dismissal forgets the user's choice.
    if (chosen && chosen.sessionId !== context.sessionId) {
      setChosen((current) => (current === chosen ? undefined : current));
    }
  }, [chosen, context.sessionId]);
  const closeDock = () => {
    // These are view flags. Hiding the terminal never terminates a session's shell.
    setTerminalPanelOpen(false);
    openChangesPanel(false);
    if (dockId === 'side-chat') context.sideChat?.close();
    setChosen(undefined);
    const focused = document.activeElement;
    const returnTo =
      focused instanceof HTMLElement && focused.closest('.session-tools')
        ? focused
        : opener.current?.deref();
    requestAnimationFrame(() => {
      const target =
        returnTo?.isConnected && returnTo.getClientRects().length > 0
          ? returnTo
          : document.querySelector<HTMLElement>(`[data-testid="tool-${dockId ?? ''}"]`);
      (target ?? document.querySelector<HTMLElement>('.composer-editor'))?.focus();
    });
  };
  return (
    <Presentation.Provider value={{ railOpen, setRailOpen, dockId, closeDock }}>
      {children}
    </Presentation.Provider>
  );
}

/** Actions mirror the panels PiArc can actually open for this session. */
export function SessionTools({ context }: { context: PanelContext }) {
  const t = useT();
  const { runCommand } = useUi();
  const { railOpen, setRailOpen, dockId, closeDock } = usePanelPresentation();
  if (!context.sessionId) return null;
  return (
    <div className="session-tools" role="group" aria-label={t('panels.tools')}>
      <IconButton
        data-testid="tool-rail"
        label={t('panels.rail')}
        aria-pressed={railOpen}
        aria-controls={railOpen ? 'session-rail' : undefined}
        onClick={() => {
          setRailOpen(!railOpen);
        }}
      >
        <RailIcon />
      </IconButton>
      <IconButton
        data-testid="tool-terminal"
        label={t('panel.terminal')}
        aria-pressed={dockId === 'terminal'}
        onClick={() => {
          if (dockId === 'terminal') closeDock();
          else if (context.terminal) showPanel('terminal');
          else runCommand('terminal.toggle');
        }}
      >
        <TerminalIcon />
      </IconButton>
      <IconButton
        data-testid="tool-changes"
        label={t('panel.changes')}
        aria-pressed={dockId === 'changes'}
        onClick={() => {
          if (dockId === 'changes') closeDock();
          else {
            openChangesPanel(true);
            showPanel('changes');
          }
        }}
      >
        <ChangesIcon />
      </IconButton>
      <IconButton
        data-testid="tool-background-tasks"
        label={t('panel.backgroundTasks')}
        aria-pressed={dockId === 'background-tasks'}
        onClick={() => {
          if (dockId === 'background-tasks') closeDock();
          else showPanel('background-tasks');
        }}
      >
        <TasksIcon />
      </IconButton>
      <IconButton
        data-testid="tool-side-chat"
        label={t('sideChat.title')}
        aria-pressed={dockId === 'side-chat'}
        onClick={() => {
          if (dockId === 'side-chat') closeDock();
          else runCommand('session.sideChat');
        }}
      >
        <SideChatIcon />
      </IconButton>
    </div>
  );
}
