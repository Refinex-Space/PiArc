// Annotating a frozen page (design addendum B3.3): the page's view is hidden and its screenshot
// shows on a canvas `#browser-annotate` with rectangles, ellipses, arrows, pen strokes, text,
// numbered markers and redaction, in five token colors and three widths, with undo, redo and
// clear. Boxes and markers are numbered and take a comment each. "Add to conversation (N)" hands
// the drawn image and the numbered items to the composer; leaving with drawings asks first.
// The same surface cuts a region out of the screenshot for the screenshot menu (B3.4).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { BrowserImage } from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import type { BrowserContextItem } from '../composer/browser-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { Dialog } from '../shell/Dialog.js';
import {
  AnnotateIcon,
  ArrowToolIcon,
  ClearIcon,
  EllipseIcon,
  MarkerIcon,
  RectIcon,
  RedactIcon,
  RedoIcon,
  TextToolIcon,
  UndoIcon,
} from '../shell/icons.js';
import {
  addShape,
  ANNOTATE_COLORS,
  ANNOTATE_TOOLS,
  ANNOTATE_WIDTHS,
  annotationItems,
  bigEnough,
  clear,
  EMPTY_ANNOTATION,
  hasWork,
  numbered,
  rectOf,
  redo,
  setComment,
  undo,
  type Annotation,
  type AnnotateColor,
  type AnnotateTool,
  type AnnotateWidth,
  type Point,
  type Shape,
} from './annotate-model.js';
import { canvasImage, loadImage } from './images.js';

/** The design token of each color. */
const COLOR_TOKENS: Readonly<Record<AnnotateColor, string>> = {
  danger: '--piarc-state-danger',
  warning: '--piarc-state-warning',
  success: '--piarc-state-success',
  accent: '--piarc-accent-solid',
  neutral: '--piarc-text-primary',
};

const TOOL_LABELS: Readonly<Record<AnnotateTool, MessageId>> = {
  rect: 'browser.annotate.tool.rect',
  ellipse: 'browser.annotate.tool.ellipse',
  arrow: 'browser.annotate.tool.arrow',
  pen: 'browser.annotate.tool.pen',
  text: 'browser.annotate.tool.text',
  marker: 'browser.annotate.tool.marker',
  redact: 'browser.annotate.tool.redact',
};

const COLOR_LABELS: Readonly<Record<AnnotateColor, MessageId>> = {
  danger: 'browser.annotate.color.danger',
  warning: 'browser.annotate.color.warning',
  success: 'browser.annotate.color.success',
  accent: 'browser.annotate.color.accent',
  neutral: 'browser.annotate.color.neutral',
};

const WIDTH_LABELS: Readonly<Record<AnnotateWidth, MessageId>> = {
  2: 'browser.annotate.width.thin',
  4: 'browser.annotate.width.medium',
  8: 'browser.annotate.width.thick',
};

function ToolGlyph({ tool }: { readonly tool: AnnotateTool }) {
  switch (tool) {
    case 'rect':
      return <RectIcon />;
    case 'ellipse':
      return <EllipseIcon />;
    case 'arrow':
      return <ArrowToolIcon />;
    case 'pen':
      return <AnnotateIcon />;
    case 'text':
      return <TextToolIcon />;
    case 'marker':
      return <MarkerIcon />;
    case 'redact':
      return <RedactIcon />;
  }
}

interface Palette {
  readonly colors: Readonly<Record<AnnotateColor, string>>;
  readonly onAccent: string;
  readonly font: string;
}

function paletteOf(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const read = (token: string) => style.getPropertyValue(token).trim();
  const colors: Record<AnnotateColor, string> = {
    danger: read(COLOR_TOKENS.danger),
    warning: read(COLOR_TOKENS.warning),
    success: read(COLOR_TOKENS.success),
    accent: read(COLOR_TOKENS.accent),
    neutral: read(COLOR_TOKENS.neutral),
  };
  return { colors, onAccent: read('--piarc-text-on-accent'), font: style.fontFamily };
}

/** Draws `shape` on `context`; `scale` turns CSS pixels of the shown image into image pixels. */
function drawShape(
  context: CanvasRenderingContext2D,
  shape: Shape,
  n: number | undefined,
  palette: Palette,
  scale: number,
): void {
  const color = palette.colors[shape.color];
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = shape.width * scale;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const badge = (at: Point) => {
    const radius = 11 * scale;
    context.beginPath();
    context.arc(at.x, at.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.fillStyle = palette.onAccent;
    context.font = `600 ${String(13 * scale)}px ${palette.font}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(n ?? ''), at.x, at.y);
  };
  switch (shape.kind) {
    case 'rect':
    case 'redact': {
      const area = rectOf(shape.from, shape.to);
      if (shape.kind === 'redact') {
        // Solid, so nothing of what is under it can be read back from the image.
        context.fillStyle = palette.colors.neutral;
        context.fillRect(area.x, area.y, area.width, area.height);
      } else {
        context.strokeRect(area.x, area.y, area.width, area.height);
        if (n !== undefined) badge({ x: area.x, y: area.y });
      }
      return;
    }
    case 'ellipse': {
      const area = rectOf(shape.from, shape.to);
      context.beginPath();
      context.ellipse(
        area.x + area.width / 2,
        area.y + area.height / 2,
        Math.max(1, area.width / 2),
        Math.max(1, area.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      if (n !== undefined) badge({ x: area.x, y: area.y });
      return;
    }
    case 'arrow': {
      const { from, to } = shape;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = Math.max(10, shape.width * 4) * scale;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.moveTo(to.x, to.y);
      context.lineTo(
        to.x - head * Math.cos(angle - Math.PI / 7),
        to.y - head * Math.sin(angle - Math.PI / 7),
      );
      context.moveTo(to.x, to.y);
      context.lineTo(
        to.x - head * Math.cos(angle + Math.PI / 7),
        to.y - head * Math.sin(angle + Math.PI / 7),
      );
      context.stroke();
      return;
    }
    case 'pen': {
      const [first, ...rest] = shape.points;
      if (first === undefined) return;
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      context.stroke();
      return;
    }
    case 'text':
      context.font = `600 ${String((12 + shape.width * 2) * scale)}px ${palette.font}`;
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.fillText(shape.text, shape.at.x, shape.at.y);
      return;
    case 'marker':
      badge(shape.at);
      return;
  }
}

/** Draws the screenshot and the shapes. */
function paint(
  canvas: HTMLCanvasElement,
  background: HTMLImageElement | undefined,
  shapes: readonly Shape[],
  draft: Shape | undefined,
): void {
  const context = canvas.getContext('2d');
  if (context === null) return;
  const palette = paletteOf(canvas);
  const shown = canvas.getBoundingClientRect().width;
  const scale = shown > 0 ? canvas.width / shown : 1;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (background !== undefined) context.drawImage(background, 0, 0);
  const numbers = new Map(numbered(shapes).map(({ n, shape }) => [shape.id, n]));
  for (const shape of shapes) drawShape(context, shape, numbers.get(shape.id), palette, scale);
  if (draft !== undefined) drawShape(context, draft, numbers.size + 1, palette, scale);
}

export function AnnotateSurface({
  image,
  mode,
  onAdd,
  onRegion,
  onClose,
}: {
  readonly image: BrowserImage;
  /** `annotate` draws; `region` takes one rectangle (the screenshot menu's region). */
  readonly mode: 'annotate' | 'region';
  readonly onAdd: (image: BrowserImage, items: BrowserContextItem[]) => void;
  readonly onRegion: (rect: { x: number; y: number; width: number; height: number }) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [background, setBackground] = useState<HTMLImageElement>();
  const [state, setState] = useState<Annotation>(EMPTY_ANNOTATION);
  const [tool, setTool] = useState<AnnotateTool>('rect');
  const [color, setColor] = useState<AnnotateColor>('danger');
  const [width, setWidth] = useState<AnnotateWidth>(4);
  const [draft, setDraft] = useState<Shape>();
  const [typing, setTyping] = useState<{ at: Point; shown: Point; value: string }>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);

  useEffect(() => {
    let alive = true;
    loadImage(image.data)
      .then((loaded) => {
        if (alive) setBackground(loaded);
      })
      .catch((error: unknown) => {
        console.warn('[browser] the screenshot did not load', error);
      });
    return () => {
      alive = false;
    };
  }, [image.data]);

  useEffect(() => {
    if (canvas.current !== null) paint(canvas.current, background, state.shapes, draft);
  }, [background, state.shapes, draft]);

  const leave = useCallback(() => {
    if (mode === 'annotate' && hasWork(state)) setConfirm(true);
    else onClose();
  }, [mode, state, onClose]);

  const point = (event: PointerEvent<HTMLCanvasElement>): { image: Point; shown: Point } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = rect.width > 0 ? image.width / rect.width : 1;
    const sy = rect.height > 0 ? image.height / rect.height : 1;
    const shown = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { image: { x: shown.x * sx, y: shown.y * sy }, shown };
  };
  const id = () => `shape-${String(nextId.current++)}`;

  const onDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || typing !== undefined) return;
    const at = point(event);
    if (mode === 'annotate' && tool === 'marker') {
      setState((current) =>
        addShape(current, { id: id(), kind: 'marker', color, width, at: at.image }),
      );
      return;
    }
    if (mode === 'annotate' && tool === 'text') {
      setTyping({ at: at.image, shown: at.shown, value: '' });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (mode === 'annotate' && tool === 'pen') {
      setDraft({ id: id(), kind: 'pen', color, width, points: [at.image] });
    } else {
      const kind =
        mode === 'annotate' && (tool === 'ellipse' || tool === 'arrow' || tool === 'redact')
          ? tool
          : 'rect';
      setDraft({ id: id(), kind, color, width, from: at.image, to: at.image });
    }
  };
  const onMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (draft === undefined) return;
    const at = point(event).image;
    setDraft(
      draft.kind === 'pen'
        ? { ...draft, points: [...draft.points, at].slice(-4000) }
        : draft.kind === 'text' || draft.kind === 'marker'
          ? draft
          : { ...draft, to: at },
    );
  };
  const onUp = () => {
    const shape = draft;
    setDraft(undefined);
    if (shape === undefined) return;
    if (shape.kind === 'pen') {
      if (shape.points.length > 1) setState((current) => addShape(current, shape));
      return;
    }
    if (shape.kind === 'text' || shape.kind === 'marker' || !bigEnough(shape.from, shape.to))
      return;
    if (mode === 'region') onRegion(rectOf(shape.from, shape.to));
    else setState((current) => addShape(current, shape));
  };

  const commitText = () => {
    const entry = typing;
    setTyping(undefined);
    if (entry === undefined || entry.value.trim() === '') return;
    setState((current) =>
      addShape(current, {
        id: id(),
        kind: 'text',
        color,
        width,
        at: entry.at,
        text: entry.value.slice(0, 200),
      }),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent) || event.defaultPrevented) return;
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (typing !== undefined) setTyping(undefined);
      else leave();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!editing && mod && event.code === 'KeyZ') {
      event.preventDefault();
      setState((current) => (event.shiftKey ? redo(current) : undo(current)));
    }
  };

  const add = async () => {
    const element = canvas.current;
    if (element === null) return;
    setBusy(true);
    try {
      paint(element, background, state.shapes, undefined);
      onAdd(await canvasImage(element), annotationItems(state));
    } finally {
      setBusy(false);
    }
  };

  const items = numbered(state.shapes);
  return (
    <div
      id="browser-annotate"
      className="browser-annotate"
      data-testid="browser-annotate"
      data-mode={mode}
      role="region"
      aria-label={t(mode === 'region' ? 'browser.annotate.region' : 'browser.annotate.title')}
      onKeyDown={onKeyDown}
    >
      <div className="browser-annotate-bar" role="toolbar" aria-label={t('browser.annotate.tools')}>
        {mode === 'region' ? (
          <span className="browser-annotate-hint">{t('browser.annotate.regionHint')}</span>
        ) : (
          <>
            <div
              className="browser-annotate-group"
              role="group"
              aria-label={t('browser.annotate.tools')}
            >
              {ANNOTATE_TOOLS.map((each) => (
                <IconButton
                  key={each}
                  size="sm"
                  label={t(TOOL_LABELS[each])}
                  aria-pressed={tool === each}
                  data-testid={`browser-annotate-tool-${each}`}
                  onClick={() => {
                    setTool(each);
                  }}
                >
                  <ToolGlyph tool={each} />
                </IconButton>
              ))}
            </div>
            <div
              className="browser-annotate-group"
              role="group"
              aria-label={t('browser.annotate.colors')}
            >
              {ANNOTATE_COLORS.map((each) => (
                <button
                  key={each}
                  type="button"
                  className="browser-annotate-swatch"
                  data-color={each}
                  aria-label={t(COLOR_LABELS[each])}
                  data-tooltip={t(COLOR_LABELS[each])}
                  aria-pressed={color === each}
                  data-testid={`browser-annotate-color-${each}`}
                  onClick={() => {
                    setColor(each);
                  }}
                />
              ))}
            </div>
            <div
              className="browser-annotate-group"
              role="group"
              aria-label={t('browser.annotate.widths')}
            >
              {ANNOTATE_WIDTHS.map((each) => (
                <button
                  key={each}
                  type="button"
                  className="browser-annotate-width"
                  data-width={each}
                  aria-label={t(WIDTH_LABELS[each])}
                  data-tooltip={t(WIDTH_LABELS[each])}
                  aria-pressed={width === each}
                  data-testid={`browser-annotate-width-${String(each)}`}
                  onClick={() => {
                    setWidth(each);
                  }}
                >
                  <span className="browser-annotate-width-line" />
                </button>
              ))}
            </div>
            <div className="browser-annotate-group">
              <IconButton
                size="sm"
                label={t('browser.annotate.undo')}
                keys="Mod+Z"
                disabled={state.past.length === 0}
                data-testid="browser-annotate-undo"
                onClick={() => {
                  setState(undo);
                }}
              >
                <UndoIcon />
              </IconButton>
              <IconButton
                size="sm"
                label={t('browser.annotate.redo')}
                keys="Mod+Shift+Z"
                disabled={state.future.length === 0}
                data-testid="browser-annotate-redo"
                onClick={() => {
                  setState(redo);
                }}
              >
                <RedoIcon />
              </IconButton>
              <IconButton
                size="sm"
                label={t('browser.annotate.clear')}
                disabled={state.shapes.length === 0}
                data-testid="browser-annotate-clear"
                onClick={() => {
                  setState(clear);
                }}
              >
                <ClearIcon />
              </IconButton>
            </div>
          </>
        )}
        <div className="browser-annotate-end">
          <Button size="small" data-testid="browser-annotate-cancel" onClick={leave}>
            {t('browser.annotate.cancel')}
          </Button>
          {mode === 'annotate' && (
            <Button
              variant="primary"
              size="small"
              loading={busy}
              data-testid="browser-annotate-add"
              onClick={() => {
                void add();
              }}
            >
              {t('browser.picks.add', { count: Math.max(1, items.length) })}
            </Button>
          )}
        </div>
      </div>
      <div className="browser-annotate-stage">
        <div className="browser-annotate-frame">
          <canvas
            ref={canvas}
            className="browser-annotate-canvas"
            data-testid="browser-annotate-canvas"
            data-tool={mode === 'region' ? 'region' : tool}
            data-shapes={state.shapes.length}
            width={image.width}
            height={image.height}
            style={{ aspectRatio: `${String(image.width)} / ${String(image.height)}` }}
            role="img"
            aria-label={t('browser.annotate.canvas')}
            onPointerDown={onDown}
            // The text field opens on pointerdown and takes the focus; the mousedown that
            // follows would move the focus to the page and close the empty field at once.
            onMouseDown={(event) => {
              if (mode === 'annotate' && tool === 'text') event.preventDefault();
            }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => {
              setDraft(undefined);
            }}
          />
          {typing !== undefined && (
            <input
              className="browser-annotate-text"
              data-testid="browser-annotate-text"
              aria-label={t('browser.annotate.tool.text')}
              style={{ left: typing.shown.x, top: typing.shown.y }}
              // The text field opens where the user clicked and takes the focus at once.
              ref={(element) => {
                element?.focus();
              }}
              value={typing.value}
              maxLength={200}
              onChange={(event) => {
                setTyping({ ...typing, value: event.target.value });
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event.nativeEvent)) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitText();
                }
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>
      {mode === 'annotate' && items.length > 0 && (
        <ol className="browser-annotate-comments" data-testid="browser-annotate-comments">
          {items.map(({ n, shape }) => (
            <li key={shape.id}>
              <label htmlFor={`browser-annotate-comment-${shape.id}`}>
                {t('browser.picks.number', { n })}
              </label>
              <textarea
                id={`browser-annotate-comment-${shape.id}`}
                rows={1}
                data-testid="browser-annotate-comment"
                placeholder={t('browser.picks.commentPlaceholder')}
                value={state.comments[shape.id] ?? ''}
                onChange={(event) => {
                  const value = event.target.value.slice(0, 2000);
                  setState((current) => setComment(current, shape.id, value));
                }}
              />
            </li>
          ))}
        </ol>
      )}
      {confirm && (
        <Dialog
          labelledBy="browser-annotate-discard-title"
          testId="browser-annotate-discard"
          onCancel={() => {
            setConfirm(false);
          }}
        >
          <h2 id="browser-annotate-discard-title">{t('browser.annotate.discardTitle')}</h2>
          <p>{t('browser.annotate.discardDetail')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              data-autofocus
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t('browser.annotate.keep')}
            </button>
            <button
              type="button"
              data-testid="browser-annotate-discard-confirm"
              onClick={() => {
                setConfirm(false);
                onClose();
              }}
            >
              {t('browser.annotate.discard')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
