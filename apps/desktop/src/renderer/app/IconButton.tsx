// Toolbar controls share the native button semantics, tooltip, focus and pressed surface. The
// accessible name is the label; the tooltip repeats it, with the shortcut's keycaps when given.
import type { ComponentPropsWithRef } from 'react';

type Props = ComponentPropsWithRef<'button'> & {
  readonly label: string;
  /** A `Mod+Enter`-style binding shown in the tooltip and announced as the shortcut. */
  readonly keys?: string;
  /** `xs` 24, `sm` 28, `md` 32 CSS px in the comfortable density (smaller when compact). */
  readonly size?: 'xs' | 'sm' | 'md';
  /** false: no tooltip (the label is visible next to the button). */
  readonly tooltip?: boolean;
};

export function IconButton({
  label,
  keys,
  size,
  tooltip = true,
  children,
  className = '',
  ...props
}: Props) {
  const sized = size === undefined ? '' : ` is-${size}`;
  return (
    <button
      type="button"
      className={`icon-button workbench-icon${sized} ${className}`}
      aria-label={label}
      aria-keyshortcuts={keys?.replace(/\bMod\b/u, 'Control')}
      data-tooltip={tooltip ? label : undefined}
      data-tooltip-keys={tooltip ? keys : undefined}
      {...props}
    >
      {children}
    </button>
  );
}
