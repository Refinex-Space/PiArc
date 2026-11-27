// A page's controls for the page head (ADR-0101): a per-project page puts its project picker at
// the head's trailing edge, beside the title, instead of in its first section.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const PageHeadSlot = createContext<HTMLElement | null>(null);

export function PageHeadActions({ children }: { readonly children: ReactNode }) {
  const slot = useContext(PageHeadSlot);
  return slot ? (
    createPortal(children, slot)
  ) : (
    <div className="settings-page-actions">{children}</div>
  );
}
