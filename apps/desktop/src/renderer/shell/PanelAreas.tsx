// The resizable session rail belongs to the conversation tile.
import { useRef } from 'react';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { RailContents } from './RailContents.js';
import { usePanelPresentation } from './WorkbenchPanels.js';
import { panelsFor, usePanels, type useRequestedPanel, type PanelContext } from './registry.js';

interface AreaProps {
  readonly context: PanelContext;
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (size: number) => void;
}

function PanelDivider({ size, min, max, onResize }: Omit<AreaProps, 'context'>) {
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
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        onResize(drag.current.size + drag.current.origin - event.clientX);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
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
  const panels = panelsFor(registered, 'rail', context);
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
        <PanelDivider {...sizing} />
        <RailContents
          key={context.sessionId}
          context={context}
          registered={registered}
          handled={handled}
        />
      </aside>
    </>
  );
}
