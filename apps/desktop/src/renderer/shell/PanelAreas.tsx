// The right rail and the dock (architecture section 8.2): containers for the panels other tasks
// register (`registry.ts`). An area with nothing registered renders nothing; one with panels
// shows tabs, remembers its size and can be resized.
import { useState } from 'react';

import { useT } from '../app/app-context.js';
import { panelsFor, usePanels, type PanelArea, type PanelContext } from './registry.js';

function Area({
  area,
  context,
  size,
  onResize,
}: {
  readonly area: PanelArea;
  readonly context: PanelContext;
  readonly size: number;
  readonly onResize: (size: number) => void;
}) {
  const t = useT();
  const panels = panelsFor(usePanels(), area, context);
  const [active, setActive] = useState<string | undefined>(undefined);
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
      data-testid={`panel-area-${area}`}
    >
      <div
        className={`resizer ${vertical ? 'resizer-x' : 'resizer-y'}`}
        role="separator"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        onPointerDown={startResize}
      />
      <div className="panel-tabs" role="tablist">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            aria-selected={panel === shown}
            className={`panel-tab${panel === shown ? ' is-active' : ''}`}
            onClick={() => {
              setActive(panel.id);
            }}
          >
            {t(panel.title)}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {shown?.render(context)}
      </div>
    </aside>
  );
}

export function RailArea(props: {
  context: PanelContext;
  size: number;
  onResize: (n: number) => void;
}) {
  return <Area area="rail" {...props} />;
}

export function DockArea(props: {
  context: PanelContext;
  size: number;
  onResize: (n: number) => void;
}) {
  return <Area area="dock" {...props} />;
}
