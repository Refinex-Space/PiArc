// A native action button. The original label stays in layout while an operation is pending.
import type { ComponentPropsWithRef } from 'react';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: 'secondary' | 'primary' | 'ghost' | 'destructive';
  readonly size?: 'regular' | 'small';
  readonly loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'regular',
  loading,
  disabled,
  children,
  className,
  type = 'button',
  ...native
}: ButtonProps) {
  const classes = ['button', 'button-' + variant, size === 'small' && 'button-small', className];
  return (
    <button
      {...native}
      type={type}
      disabled={disabled === true || loading === true}
      aria-busy={loading ? true : native['aria-busy']}
      className={classes.filter(Boolean).join(' ')}
    >
      {loading === undefined ? children : <span className="button-label">{children}</span>}
    </button>
  );
}
