import { useRef } from 'react';
import { useT } from '../../app/app-context.js';
export function SplitDivider({
  stacked,
  ratio,
  change,
}: {
  stacked: boolean;
  ratio: number;
  change: (ratio: number) => void;
}) {
  const t = useT(),
    drag = useRef<{ start: number; extent: number; ratio: number } | undefined>(undefined);
  const clamp = (n: number) => {
    change(Math.max(0.2, Math.min(0.8, n)));
  };
  return (
    <div
      className="markdown-split-divider"
      tabIndex={0}
      role="separator"
      aria-label={t('files.md.resizeSplit')}
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(100 * ratio)}
      onDoubleClick={() => {
        change(0.5);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const box = e.currentTarget.parentElement?.getBoundingClientRect();
        if (!box) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          start: stacked ? e.clientY : e.clientX,
          extent: stacked ? box.height : box.width,
          ratio,
        };
      }}
      onPointerMove={(e) => {
        const s = drag.current;
        if (s && s.extent > 0)
          clamp(s.ratio + ((stacked ? e.clientY : e.clientX) - s.start) / s.extent);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(e) => {
        const delta =
          e.key === (stacked ? 'ArrowUp' : 'ArrowLeft')
            ? -0.05
            : e.key === (stacked ? 'ArrowDown' : 'ArrowRight')
              ? 0.05
              : 0;
        if (delta || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          clamp(delta ? ratio + delta : e.key === 'Home' ? 0.2 : 0.8);
        }
      }}
    />
  );
}
