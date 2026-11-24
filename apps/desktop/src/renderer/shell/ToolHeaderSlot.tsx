import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const Header = createContext<{
  visible: boolean;
  target: HTMLDivElement | null;
  attach: (el: HTMLDivElement | null) => void;
} | null>(null);

export function ToolHeaderProvider({
  children,
  visible = true,
}: {
  children: ReactNode;
  visible?: boolean;
}) {
  const [target, attach] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, attach, visible }), [target, visible]);
  return <Header.Provider value={value}>{children}</Header.Provider>;
}

/** The tool supplies its own tabs and actions in the same title row as the tile controls. */
export function ToolHeaderTarget() {
  const header = useContext(Header);
  return <div ref={header?.attach} className="tool-header-slot" />;
}
export function ToolHeaderContent({ children }: { children: ReactNode }) {
  const header = useContext(Header);
  if (!header) return children;
  return header.target ? createPortal(children, header.target) : null;
}

/** Actual tile placement, independent of a document reader’s own scroll position. */
export function useToolVisible() {
  return useContext(Header)?.visible ?? true;
}
