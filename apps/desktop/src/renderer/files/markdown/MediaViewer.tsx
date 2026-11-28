// The document and its original source stay mounted while one passive image is inspected.
// Layout and gestures follow Markdown Studio e6ebd0c, web/core/features/viewers/markdown/media
// (Apache-2.0); focus, input ownership and the image resource stay with PiArc's current surface.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { Dialog } from '../../shell/Dialog.js';
import { CloseIcon } from '../../shell/icons.js';
import {
  constrain,
  MAX_ZOOM,
  MIN_ZOOM,
  place,
  rotated,
  stepZoom,
  zoomAround,
  type Camera,
  type Fitting,
  type Point,
  type MediaSize,
} from './media-camera.js';

type MediaAction = 'smaller' | 'larger' | 'window' | 'width' | 'actual' | 'rotate' | 'reset';
const buttons: Record<MediaAction, { icon: ReactNode; shortcut: string }> = {
  smaller: { icon: <path d="M4 10h12" />, shortcut: '−' },
  larger: { icon: <path d="M4 10h12M10 4v12" />, shortcut: '+' },
  window: { icon: <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />, shortcut: '0' },
  width: { icon: <path d="M2 4v12M18 4v12M5 10h10M8 7l-3 3 3 3m4-6 3 3-3 3" />, shortcut: 'W' },
  actual: {
    icon: (
      <>
        <path d="M2.5 8 5 6v8m8.5-6 2.5-2v8" />
        <circle cx="10" cy="8" r=".6" />
        <circle cx="10" cy="12" r=".6" />
      </>
    ),
    shortcut: '1',
  },
  rotate: { icon: <path d="M15.5 7.5a6 6 0 1 0 .2 5M16 3v5h-5" />, shortcut: 'R' },
  reset: { icon: <path d="M4.5 7.5a6 6 0 1 1-.2 5M4 3v5h5" />, shortcut: 'Home' },
};
interface ViewerProps {
  src: string;
  label: string;
  kind: 'image' | 'diagram';
  natural?: MediaSize;
  onClose: () => void;
}
const percentages = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16];
function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function localPoint(node: HTMLElement, x: number, y: number): Point {
  const rect = node.getBoundingClientRect();
  return { x: x - rect.left, y: y - rect.top };
}

export function MediaViewer({ src, label, kind, natural: provided, onClose }: ViewerProps) {
  const { t, format } = useApp(),
    doc = useSurfaceDocument(),
    title = useId();
  const canvas = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<MediaSize | undefined>(provided),
    [viewport, setViewport] = useState<MediaSize>({ width: 0, height: 0 });
  const [state, setState] = useState<Camera | null>(null),
    [dragging, setDragging] = useState(false),
    [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, Point>()),
    gesture = useRef<{ start: Point; blank: boolean; moved: boolean } | undefined>(undefined);
  const cap = kind === 'diagram' ? 2 : 1;
  useLayoutEffect(() => {
    const node = canvas.current,
      win = doc.defaultView;
    if (!node || !win) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = node;
      setViewport((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const resize = new win.ResizeObserver(measure);
    resize.observe(node);
    return () => {
      resize.disconnect();
    };
  }, [doc]);
  useLayoutEffect(() => {
    if (!natural || !viewport.width || !viewport.height) return;
    setState((v) =>
      v && !v.fit
        ? constrain(v, natural, viewport)
        : place(natural, viewport, v?.turns ?? 0, v?.fit ?? 'window', cap),
    );
  }, [natural, viewport, cap]);
  function fit(mode: Fitting, turn?: number) {
    if (natural) setState((v) => place(natural, viewport, turn ?? v?.turns ?? 0, mode, cap));
  }
  function changeZoom(value: number | ((current: number) => number), from?: Point, to?: Point) {
    if (!natural) return;
    const point = from ?? { x: viewport.width / 2, y: viewport.height / 2 };
    setState(
      (v) =>
        v &&
        zoomAround(
          v,
          typeof value === 'number' ? value : value(v.zoom),
          point,
          to ?? point,
          natural,
          viewport,
        ),
    );
  }
  function pan(dx: number, dy: number) {
    if (natural)
      setState(
        (v) => v && constrain({ ...v, x: v.x + dx, y: v.y + dy, fit: null }, natural, viewport),
      );
  }
  function rotate(direction: number) {
    if (natural)
      setState(
        (v) => v && place(natural, viewport, (v.turns + direction + 4) % 4, v.fit, cap, v.zoom),
      );
  }
  function run(action: MediaAction) {
    switch (action) {
      case 'smaller':
        changeZoom((z) => stepZoom(z, -1));
        break;
      case 'larger':
        changeZoom((z) => stepZoom(z, 1));
        break;
      case 'width':
      case 'window':
        fit(action);
        break;
      case 'actual':
        fit(null);
        break;
      case 'rotate':
        rotate(1);
        break;
      case 'reset':
        fit('window', 0);
        break;
    }
  }
  const latest = useRef({ pan, changeZoom });
  latest.current = { pan, changeZoom };
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? node.clientHeight : 1;
      const y = e.deltaY * multiplier;
      if (e.ctrlKey || e.metaKey) {
        latest.current.changeZoom(
          (z) => z * Math.exp(-Math.max(-400, Math.min(400, y)) / 300),
          localPoint(node, e.clientX, e.clientY),
        );
      } else if (e.shiftKey && !e.deltaX) latest.current.pan(-y, 0);
      else latest.current.pan(-e.deltaX * multiplier, -y);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', wheel);
    };
  }, [doc]);
  function keyDown(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.altKey || e.key === 'Tab' || e.key === 'Escape') return;
    if (
      (e.target as HTMLElement).tagName === 'SELECT' &&
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
    )
      return;
    if ((e.metaKey || e.ctrlKey) && !['-', '_', '+', '=', '0'].includes(e.key)) return;
    const step = e.shiftKey ? 144 : 48;
    switch (e.key.toLowerCase()) {
      case '+':
      case '=':
        run('larger');
        break;
      case '-':
      case '_':
        run('smaller');
        break;
      case '0':
        fit('window');
        break;
      case 'w':
        fit('width');
        break;
      case '1':
        fit(null);
        break;
      case 'r':
        rotate(e.shiftKey ? -1 : 1);
        break;
      case 'home':
        run('reset');
        break;
      case 'arrowleft':
        pan(step, 0);
        break;
      case 'arrowright':
        pan(-step, 0);
        break;
      case 'arrowup':
        pan(0, step);
        break;
      case 'arrowdown':
        pan(0, -step);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
  function onArtwork(x: number, y: number) {
    const r = stage.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const node = e.currentTarget,
      point = localPoint(node, e.clientX, e.clientY);
    e.preventDefault();
    node.focus({ preventScroll: true });
    node.setPointerCapture(e.pointerId);
    if (!pointers.current.size)
      gesture.current = {
        start: point,
        blank: e.button === 0 && !onArtwork(e.clientX, e.clientY),
        moved: false,
      };
    else if (gesture.current) gesture.current.moved = true;
    pointers.current.set(e.pointerId, point);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const points = pointers.current,
      old = points.get(e.pointerId),
      track = gesture.current;
    if (!old || !track) return;
    const point = localPoint(e.currentTarget, e.clientX, e.clientY);
    if (!track.moved && distance(track.start, point) < 4) return;
    track.moved = true;
    setDragging(true);
    const other = [...points].find(([id]) => id !== e.pointerId)?.[1];
    points.set(e.pointerId, point);
    if (other) {
      const ratio = distance(point, other) / Math.max(1, distance(old, other));
      changeZoom((z) => z * ratio, midpoint(old, other), midpoint(point, other));
    } else pan(point.x - old.x, point.y - old.y);
  }
  function end(e: PointerEvent<HTMLDivElement>, completed: boolean) {
    if (!pointers.current.delete(e.pointerId) || pointers.current.size) return;
    const track = gesture.current;
    gesture.current = undefined;
    setDragging(false);
    if (completed && track?.blank && !track.moved) onClose();
  }
  function tool(action: MediaAction) {
    const label = t(`files.media.${action}`),
      { icon, shortcut } = buttons[action];
    const disabled =
      failed ||
      !state ||
      (action === 'larger' && state.zoom >= MAX_ZOOM) ||
      (action === 'smaller' && state.zoom <= MIN_ZOOM);
    return (
      <IconButton
        label={label}
        title={label + ' (' + shortcut + ')'}
        disabled={disabled}
        {...(action === 'window' || action === 'width'
          ? { 'aria-pressed': state?.fit === action }
          : {})}
        onClick={() => {
          run(action);
        }}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {icon}
        </svg>
      </IconButton>
    );
  }
  const zoom = state?.zoom ?? 1,
    percent = (z: number) => format.number(z, { style: 'percent', maximumFractionDigits: 1 });
  const box = natural ? rotated(natural, state?.turns ?? 0) : undefined;
  return createPortal(
    <div
      className="md-media-layer"
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <Dialog
        testId="markdown-image-dialog"
        className="md-media-viewer"
        labelledBy={title}
        onCancel={onClose}
      >
        <div className="md-media-content" onKeyDown={keyDown}>
          <div className="md-media-header">
            <div className="md-media-toolbar" role="group" aria-label={t('files.media.controls')}>
              {tool('smaller')}
              <select
                aria-label={t('files.media.level')}
                data-testid="media-zoom"
                value={zoom}
                disabled={!state || failed}
                onChange={(e) => {
                  changeZoom(Number(e.target.value));
                }}
              >
                {!percentages.includes(zoom) && <option value={zoom}>{percent(zoom)}</option>}
                {percentages.map((z) => (
                  <option key={z} value={z}>
                    {percent(z)}
                  </option>
                ))}
              </select>
              {tool('larger')}
              <i aria-hidden="true" />
              {tool('window')}
              {tool('width')}
              {tool('actual')}
              <i aria-hidden="true" />
              {tool('rotate')}
              {tool('reset')}
              <i aria-hidden="true" />
              <IconButton
                label={t('files.md.close')}
                title={t('files.md.close') + ' (Esc)'}
                onClick={onClose}
              >
                <CloseIcon />
              </IconButton>
            </div>
          </div>
          <div
            className="md-media-canvas"
            data-testid="media-canvas"
            ref={canvas}
            role="group"
            aria-label={t('files.media.canvas')}
            tabIndex={0}
            data-autofocus
            data-dragging={dragging}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={(e) => {
              end(e, true);
            }}
            onPointerCancel={(e) => {
              end(e, false);
            }}
            onLostPointerCapture={(e) => {
              end(e, false);
            }}
            onDoubleClick={(e) => {
              if (!state || !natural || !onArtwork(e.clientX, e.clientY)) return;
              const fitted = place(natural, viewport, state.turns, 'window', cap).zoom;
              if (Math.abs(state.zoom - fitted) > 0.001) fit('window');
              else
                changeZoom(
                  Math.abs(fitted - 1) < 0.001 ? 2 : 1,
                  localPoint(e.currentTarget, e.clientX, e.clientY),
                );
            }}
          >
            {failed ? (
              <span role="alert">{t('files.md.imageMissing', { name: label })}</span>
            ) : (
              <div
                className="md-media-stage"
                ref={stage}
                data-testid="media-stage"
                data-kind={kind}
                data-pixelated={kind === 'image' && zoom >= 4}
                data-turns={state?.turns ?? 0}
                data-zoom={zoom}
                data-fit={state?.fit ?? 'manual'}
                style={{
                  width: box && box.width * zoom,
                  height: box && box.height * zoom,
                  transform:
                    'translate3d(' +
                    String(state?.x ?? 0) +
                    'px,' +
                    String(state?.y ?? 0) +
                    'px,0)',
                  visibility: state ? 'visible' : 'hidden',
                }}
              >
                <img
                  alt={label}
                  src={src}
                  draggable={false}
                  style={{
                    width: natural && natural.width * zoom,
                    height: natural && natural.height * zoom,
                    transform:
                      'translate(-50%, -50%) rotate(' + String((state?.turns ?? 0) * 90) + 'deg)',
                  }}
                  onLoad={(e) => {
                    if (!provided) {
                      const img = e.currentTarget;
                      if (img.naturalWidth && img.naturalHeight)
                        setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                    }
                  }}
                  onError={() => {
                    setFailed(true);
                  }}
                />
              </div>
            )}
          </div>
          <footer className="md-media-caption">
            <h2 id={title} title={label}>
              {label}
            </h2>
            {natural && (
              <span>
                {format.number(Math.round(natural.width))} ×{' '}
                {format.number(Math.round(natural.height))}
              </span>
            )}
          </footer>
        </div>
      </Dialog>
    </div>,
    doc.body,
  );
}
