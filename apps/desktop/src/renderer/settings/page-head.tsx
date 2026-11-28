// A page's controls for the page head (ADR-0101): a per-project page puts its project picker at
// the head's trailing edge, beside the title, instead of in its first section. A page with
// sub-pages (a catalog and its items) replaces the title with its own heading: a trail back to
// the page and the sub-page's title, so the view never shows two headings.
import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const PageHeadSlot = createContext<HTMLElement | null>(null);

/** Where a page's own heading goes, and the switch that hides the default one. */
export const PageHeadingSlot = createContext<{
  readonly slot: HTMLElement | null;
  readonly claim: (on: boolean) => void;
} | null>(null);

export function PageHeadActions({ children }: { readonly children: ReactNode }) {
  const slot = useContext(PageHeadSlot);
  return slot ? (
    createPortal(children, slot)
  ) : (
    <div className="settings-page-actions">{children}</div>
  );
}

/** The page's own heading in place of its title and description while it is mounted. */
export function PageHeading({ children }: { readonly children: ReactNode }) {
  const heading = useContext(PageHeadingSlot);
  const claim = heading?.claim;
  useLayoutEffect(() => {
    if (claim === undefined) return;
    claim(true);
    return () => {
      claim(false);
    };
  }, [claim]);
  if (heading === null) return <div className="settings-page-heading">{children}</div>;
  return heading.slot === null ? null : createPortal(children, heading.slot);
}
