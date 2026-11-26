// Whether something of the workbench covers the page's viewport (B1.5.2). The page is a native
// view drawn above all DOM, so a menu, dialog or tooltip over it would be hidden behind it;
// while one is there the page is hidden and a still frame shows instead. A 5×5 grid of
// `elementFromPoint` samples finds anything stacked over the viewport element.

/** Sample points per axis. */
const GRID = 5;
/** Inset of the outer samples from the viewport's edges, in CSS px. */
const INSET = 4;

/** Whether any sample point of `viewport` hits an element that is not part of it. */
export function covered(viewport: HTMLElement): boolean {
  const doc = viewport.ownerDocument;
  const rect = viewport.getBoundingClientRect();
  if (rect.width < INSET * 2 || rect.height < INSET * 2) return false;
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      const x = rect.left + INSET + ((rect.width - INSET * 2) * column) / (GRID - 1);
      const y = rect.top + INSET + ((rect.height - INSET * 2) * row) / (GRID - 1);
      const hit = doc.elementFromPoint(x, y);
      if (hit !== null && hit !== viewport && !viewport.contains(hit)) return true;
    }
  }
  return false;
}

/**
 * Calls `onChange(covered)` whenever the answer may have changed: DOM changes anywhere in the
 * document (menus, dialogs, tooltips mount and unmount), resizes and scrolls, at most once
 * per animation frame.
 */
export function watchCover(viewport: HTMLElement, onChange: (covered: boolean) => void) {
  const doc = viewport.ownerDocument;
  const view = doc.defaultView;
  let frame = 0;
  let last: boolean | undefined;
  const check = () => {
    frame = 0;
    const now = covered(viewport);
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };
  const schedule = () => {
    if (frame === 0 && view !== null) frame = view.requestAnimationFrame(check);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'hidden',
      'open',
      'data-open',
      'inert',
      'data-tooltip-open',
    ],
  });
  view?.addEventListener('resize', schedule);
  doc.addEventListener('scroll', schedule, true);
  doc.addEventListener('pointerover', schedule, true);
  schedule();
  return () => {
    observer.disconnect();
    view?.removeEventListener('resize', schedule);
    doc.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('pointerover', schedule, true);
    if (frame !== 0) view?.cancelAnimationFrame(frame);
  };
}
