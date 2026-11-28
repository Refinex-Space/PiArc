// Settings morph in over the workbench (ADR-0101) as one shared-axis move: the workbench's
// navigation fades out early while sliding left, the settings navigation fades in a beat later
// while sliding into place, and the page fades up over the opaque workbench, so two layers are
// never half transparent over the window's vibrancy at once. The morph starts only once the
// settings code is in and the starting pose has been laid out (otherwise the browser skips the
// transition and the view jumps). The workbench stays mounted and inert underneath; closing
// plays the morph back, quicker, then unmounts. Settings code loads on first use (or when the
// window is idle) so the workbench paints first.
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';

const load = () =>
  Promise.all([import('./SettingsSurface.js'), import('./pages.js')]).then(
    ([{ SettingsSurface }, { registerBuiltInSettingsPages }]) => {
      registerBuiltInSettingsPages();
      return { default: SettingsSurface };
    },
  );
let loading: ReturnType<typeof load> | undefined;
const loadOnce = () => (loading ??= load());
const SettingsContent = lazy(loadOnce);

/** Starts loading the settings code without showing it. */
export function preloadSettings(): void {
  void loadOnce();
}

/** The longest transition on `element`, in ms (0 when motion is reduced). */
function transitionMs(element: Element): number {
  const style = getComputedStyle(element);
  const seconds = (value: string) =>
    value
      .split(',')
      .map((part) => (part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)));
  const durations = seconds(style.transitionDuration);
  const delays = seconds(style.transitionDelay);
  return Math.max(0, ...durations.map((d, i) => (d + (delays[i] ?? 0)) * 1000));
}

export function SettingsLayer({
  open,
  entry,
  onClose,
  sidebarWidth,
  resizer,
}: {
  readonly open: boolean;
  /** A new number remounts the settings (a new entry point, such as a link to a field). */
  readonly entry: number;
  readonly onClose: () => void;
  readonly sidebarWidth: number;
  /** The workbench sidebar's separator: the settings navigation resizes the same width. */
  readonly resizer?: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<'in' | 'out'>(open ? 'in' : 'out');
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Each opening is a fresh settings instance, also when it lands during the closing morph.
  const [generation, setGeneration] = useState(0);

  useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !ref.current?.contains(focused)) opener.current = focused;
    setGeneration((current) => current + 1);
    setMounted(true);
  }, [open]);

  useEffect(() => {
    if (open) {
      // Start from the "out" pose, laid out, with the settings rendered: two frames after the
      // code is in, so the lazy page has mounted and its starting styles are computed.
      let cancelled = false;
      let frame = 0;
      void loadOnce().then(() => {
        if (cancelled) return;
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (cancelled) return;
            ref.current?.getBoundingClientRect();
            setPhase('in');
          });
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    if (!mounted) return;
    setPhase('out');
    const back = opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>(
          '[data-testid="open-settings"], [data-testid="expand-sidebar"]',
        );
    back?.focus({ preventScroll: true });
    const view = ref.current?.querySelector('.settings-view');
    const wait = view ? transitionMs(view) : 0;
    const timer = window.setTimeout(() => {
      setMounted(false);
    }, wait);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <div
      ref={ref}
      className="settings-layer"
      data-phase={phase}
      data-open={open}
      style={{ '--settings-sidebar-width': `${String(sidebarWidth)}px` } as React.CSSProperties}
    >
      <Suspense fallback={<div className="settings settings-surface is-loading" />}>
        <SettingsContent
          key={`${String(generation)}:${String(entry)}`}
          onClose={onClose}
          resizer={resizer}
        />
      </Suspense>
    </div>
  );
}
