// The right rail and the dock (architecture section 8.2): containers for the panels other tasks
// register (`registry.ts`). An area with nothing registered renders nothing; one with panels
// shows tabs, remembers its size and can be resized.
import { Fragment, useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import {
  panelsFor,
  usePanels,
  useRequestedPanel,
  type PanelArea,
  type PanelContext,
} from './registry.js';

function Area({
  area,
  context,
  size,
  min,
  max,
  onResize,
}: {
  readonly area: PanelArea;
  readonly context: PanelContext;
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (size: number) => void;
}) {
  const t = useT();
  const panels = panelsFor(usePanels(), area, context);
  const [active, setActive] = useState<string | undefined>(undefined);
  const requested = useRequestedPanel();
  const requestedHere = requested !== undefined && panels.some((p) => p.id === requested.id);
  useEffect(() => {
    if (requested !== undefined && requestedHere) setActive(requested.id);
  }, [requested, requestedHere]);
  if (panels.length === 0) {
    return null;
  }
  const shown = panels.find((panel) => panel.id === active) ?? panels[0];
  const vertical = area === 'rail';
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = vertical ? event.clientX : event.clientY;
    const from = size;
    const move = (moveEvent: PointerEvent) => {
      const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - start;
      onResize(from - delta);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside
      className={`panel-area panel-area-${area}`}
      style={vertical ? { width: size } : { height: size }}
      aria-label={t(vertical ? 'panels.rail' : 'panels.dock')}
      data-testid={`panel-area-${area}`}
    >
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
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (isImeComposing(event.nativeEvent)) return;
          // The separator is on the area's leading edge: moving it away from the area grows it.
          const grow = vertical ? 'ArrowLeft' : 'ArrowUp';
          const shrink = vertical ? 'ArrowRight' : 'ArrowDown';
          const step = event.key === grow ? 16 : event.key === shrink ? -16 : 0;
          if (step !== 0) {
            event.preventDefault();
            onResize(size + step);
          }
        }}
      />
      <div className="panel-tabs" role="tablist">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            aria-selected={panel === shown}
            className={`panel-tab${panel === shown ? ' is-active' : ''}`}
            data-testid={`panel-tab-${panel.id}`}
            onClick={() => {
              setActive(panel.id);
            }}
          >
            {t(panel.title)}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
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

export function RailArea(props: {
  context: PanelContext;
  size: number;
  min: number;
  max: number;
  onResize: (n: number) => void;
}) {
  return <Area area="rail" {...props} />;
}

export function DockArea(props: {
  context: PanelContext;
  size: number;
  min: number;
  max: number;
  onResize: (n: number) => void;
}) {
  return <Area area="dock" {...props} />;
}
