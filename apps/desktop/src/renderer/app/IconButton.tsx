// Toolbar controls share the native button semantics, tooltip, focus and pressed surface.
import type { ComponentPropsWithRef } from 'react';

type Props = ComponentPropsWithRef<'button'> & { readonly label: string };

export function IconButton({ label, children, className = '', ...props }: Props) {
  return (
    <button
      type="button"
      className={`icon-button workbench-icon ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
