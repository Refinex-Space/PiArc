import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const Header = createContext<{
  target: HTMLDivElement | null;
  attach: (el: HTMLDivElement | null) => void;
} | null>(null);

export function ToolHeaderProvider({ children }: { children: ReactNode }) {
  const [target, attach] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, attach }), [target]);
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
