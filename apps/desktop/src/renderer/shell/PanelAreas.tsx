// The resizable session rail belongs to the conversation tile. It slides in from the window's
// right edge and stays mounted until it has slid out (`usePresence`).
import { useRef, useState, type CSSProperties } from 'react';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { RailContents } from './RailContents.js';
import { usePresence } from './rail-motion.js';
import { usePanelPresentation } from './WorkbenchPanels.js';
import { panelsFor, usePanels, type useRequestedPanel, type PanelContext } from './registry.js';

interface AreaProps {
  readonly context: PanelContext;
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (size: number) => void;
}

const RAIL_PROPERTIES = ['width', 'translate'] as const;

function PanelDivider({
  size,
  min,
  max,
  onResize,
  onDrag,
}: Omit<AreaProps, 'context'> & { readonly onDrag: (dragging: boolean) => void }) {
  const t = useT();
  const drag = useRef<{ pointer: number; origin: number; size: number }>(undefined);
  return (
    <div
      className="resizer resizer-x"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('panels.resizeRail')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={0}
      data-testid="panel-resizer-rail"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          origin: event.clientX,
          size,
        };
        onDrag(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        onResize(drag.current.size + drag.current.origin - event.clientX);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        onDrag(false);
      }}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        const grow = 'ArrowLeft';
        const shrink = 'ArrowRight';
        if (event.key !== grow && event.key !== shrink) return;
        event.preventDefault();
        onResize(size + (event.key === grow ? 16 : -16));
      }}
    />
  );
}

export function RailArea({ context, ...sizing }: AreaProps) {
  const t = useT();
  const { railOpen, setRailOpen } = usePanelPresentation();
  const registered = usePanels();
  const handled = useRef<ReturnType<typeof useRequestedPanel>>(undefined);
  const rail = useRef<HTMLElement>(null);
  // Resizing follows the pointer directly; the width only eases when the rail opens or closes.
  const [resizing, setResizing] = useState(false);
  const panels = panelsFor(registered, 'rail', context);
  const available = context.sessionId !== undefined && panels.length > 0;
  const phase = usePresence(railOpen && available, rail, RAIL_PROPERTIES);
  if (!available || phase === 'closed') return null;
  const state = phase === 'open' ? 'open' : 'closed';
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
        data-state={state}
        aria-label={t('panels.close')}
        onClick={close}
      />
      <aside
        ref={rail}
        className="panel-area panel-area-rail workbench-rail"
        style={{ '--rail-size': `${String(sizing.size)}px` } as CSSProperties}
        data-state={state}
        data-resizing={resizing || undefined}
        inert={phase === 'closing'}
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
        <div className="rail-sheet">
          <PanelDivider {...sizing} onDrag={setResizing} />
          <RailContents
            key={context.sessionId}
            context={context}
            registered={registered}
            handled={handled}
          />
        </div>
      </aside>
    </>
  );
}
