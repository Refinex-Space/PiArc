// The session rail and the user-opened dock share resize and registry behavior. Available
// session information forms vertically stacked disclosures; tools keep their own dock tabs.
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSession } from '../store/hooks.js';
import { ChevronDownIcon, CloseIcon, ComputerIcon, FolderIcon } from './icons.js';
import { baseName } from './ui.js';
import { usePanelPresentation } from './WorkbenchPanels.js';
import {
  panelsFor,
  showPanel,
  usePanels,
  useRequestedPanel,
  type PanelArea,
  type PanelContext,
  type PanelSpec,
} from './registry.js';

export { WorkbenchPanels, SessionTools } from './WorkbenchPanels.js';

interface AreaProps {
  readonly context: PanelContext;
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (size: number) => void;
}

function PanelDivider({
  area,
  size,
  min,
  max,
  onResize,
}: Omit<AreaProps, 'context'> & { area: PanelArea }) {
  const t = useT();
  const vertical = area === 'rail';
  const drag = useRef<{ pointer: number; origin: number; size: number }>(undefined);
  return (
    <div
      className={`resizer ${vertical ? 'resizer-x' : 'resizer-y'}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={t(vertical ? 'panels.resizeRail' : 'panels.resizeDock')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={0}
      data-testid={`panel-resizer-${area}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          origin: vertical ? event.clientX : event.clientY,
          size,
        };
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        onResize(
          drag.current.size + drag.current.origin - (vertical ? event.clientX : event.clientY),
        );
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        const grow = vertical ? 'ArrowLeft' : 'ArrowUp';
        const shrink = vertical ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== grow && event.key !== shrink) return;
        event.preventDefault();
        onResize(size + (event.key === grow ? 16 : -16));
      }}
    />
  );
}

function Environment({ sessionId }: { sessionId: string }) {
  const t = useT();
  const session = useSession(sessionId);
  const folder = session?.worktreePath ?? session?.cwd ?? session?.workspace;
  return (
    <details open className="rail-section rail-environment">
      <summary>
        {t('panels.environment')}
        <ChevronDownIcon />
      </summary>
      <div className="rail-environment-row">
        <ComputerIcon />
        <span>{t('workbench.local')}</span>
      </div>
      {folder && (
        <div className="rail-environment-row" title={folder}>
          <FolderIcon />
          <span>{baseName(folder)}</span>
          <small dir="auto">{folder}</small>
        </div>
      )}
    </details>
  );
}

function RailSection({ panel, context }: { panel: PanelSpec; context: PanelContext }) {
  const t = useT();
  const id = useId();
  const header = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(panel.initiallyExpanded === true);
  const requested = useRequestedPanel();
  useEffect(() => {
    if (requested?.id === panel.id) {
      setExpanded(true);
      header.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [requested, panel.id]);
  return (
    <section className="rail-section">
      <h2>
        <button
          type="button"
          ref={header}
          id={id}
          aria-expanded={expanded}
          aria-controls={id + '-body'}
          data-testid={`panel-tab-${panel.id}`}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {t(panel.title)}
          <ChevronDownIcon />
        </button>
      </h2>
      <div id={id + '-body'} hidden={!expanded} aria-labelledby={id}>
        {expanded && panel.render(context)}
      </div>
    </section>
  );
}

export function RailArea({ context, ...sizing }: AreaProps) {
  const t = useT();
  const { railOpen, setRailOpen } = usePanelPresentation();
  const panels = panelsFor(usePanels(), 'rail', context);
  if (!railOpen || !context.sessionId || panels.length === 0) return null;
  const close = () => {
    setRailOpen(false);
    document.querySelector<HTMLElement>('[data-testid="tool-rail"]')?.focus();
  };
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="rail-backdrop"
        aria-label={t('panels.close')}
        onClick={close}
      />
      <aside
        className="panel-area panel-area-rail workbench-rail"
        style={{ width: sizing.size }}
        aria-label={t('panels.rail')}
        id="session-rail"
        data-testid="panel-area-rail"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event.nativeEvent))
            return;
          event.stopPropagation();
          close();
        }}
      >
        <PanelDivider area="rail" {...sizing} />
        <div className="panel-body rail-sections" key={context.sessionId}>
          <Environment sessionId={context.sessionId} />
          {panels.map((panel) => (
            <RailSection key={panel.id} panel={panel} context={context} />
          ))}
        </div>
      </aside>
    </>
  );
}

export function DockArea({ context, ...sizing }: AreaProps) {
  const t = useT();
  const { dockId, closeDock } = usePanelPresentation();
  const tabs = useRef<HTMLDivElement>(null);
  const panels = panelsFor(usePanels(), 'dock', context);
  const shown = panels.find((panel) => panel.id === dockId);
  // A hidden side chat may still be streaming. Keep that instance until it is explicitly
  // closed or the user leaves the session.
  if (!shown && !panels.some((panel) => panel.keepMounted)) return null;
  return (
    <aside
      className="panel-area panel-area-dock workbench-dock"
      style={{ height: sizing.size }}
      aria-label={t('panels.dock')}
      hidden={!shown}
      data-testid={shown ? 'panel-area-dock' : undefined}
    >
      <PanelDivider area="dock" {...sizing} />
      <div className="dock-heading">
        <div
          className="panel-tabs"
          role="tablist"
          aria-label={t('panels.dock')}
          ref={tabs}
          onKeyDown={(event) => {
            if (!shown || isImeComposing(event.nativeEvent)) return;
            const at = panels.indexOf(shown);
            let next: number;
            switch (event.key) {
              case 'Home':
                next = 0;
                break;
              case 'End':
                next = panels.length - 1;
                break;
              case 'ArrowLeft':
                next = (at + panels.length - 1) % panels.length;
                break;
              case 'ArrowRight':
                next = (at + 1) % panels.length;
                break;
              default:
                return;
            }
            event.preventDefault();
            const tab = tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
            tab?.focus();
            tab?.click();
          }}
        >
          {panels.map((panel) => (
            <button
              key={panel.id}
              id={`dock-tab-${panel.id}`}
              type="button"
              role="tab"
              aria-selected={panel === shown}
              tabIndex={panel === shown ? 0 : -1}
              aria-controls="dock-body"
              className={`panel-tab${panel === shown ? ' is-active' : ''}`}
              data-testid={`panel-tab-${panel.id}`}
              onClick={() => {
                showPanel(panel.id);
              }}
            >
              {t(panel.title)}
            </button>
          ))}
        </div>
        <IconButton data-testid="panel-close-dock" label={t('panels.close')} onClick={closeDock}>
          <CloseIcon />
        </IconButton>
      </div>
      <div
        className="panel-body"
        id="dock-body"
        role="tabpanel"
        aria-labelledby={shown ? `dock-tab-${shown.id}` : undefined}
      >
        {panels
          .filter((panel) => panel === shown || panel.keepMounted)
          .map((panel) =>
            panel.keepMounted ? (
              <div key={panel.id} hidden={panel !== shown}>
                {panel.render(context)}
              </div>
            ) : (
              <Fragment key={panel.id}>{panel.render(context)}</Fragment>
            ),
          )}
      </div>
    </aside>
  );
}
