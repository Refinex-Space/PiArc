// A split describes geometry, not React ownership. Every tool stays keyed by session and id.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import {
  CloseIcon,
  MaximizeIcon,
  MinimizeIcon,
  PopoutIcon,
  GripIcon,
  ChevronDownIcon,
} from './icons.js';
import { ChoiceButton, MenuPopup, useMenu } from './Menu.js';
import { onPanelRequest } from './registry.js';
import { ToolHeaderProvider, ToolHeaderTarget } from './ToolHeaderSlot.js';
import { PopoutSurface, ToolWindowPin } from './PopoutSurface.js';
import {
  dropEdge,
  moveTile,
  readTileLayout,
  resizeTiles,
  tileGeometry,
  withOpenTools,
  type Boundary,
  type Edge,
  type Rect,
  type TileLayout,
} from './tool-layout.js';

interface ToolTilesProps {
  readonly sessionId: string | undefined;
  readonly openIds: readonly string[];
  readonly renderPanel: (id: string) => ReactNode;
  readonly titleOf: (id: string) => string;
  readonly onClose: (id: string) => void;
  readonly children: ReactNode;
}

const EDGES = ['left', 'right', 'above', 'below'] as const;
const storageKey = (scope: string) => `piarc.tool-layout.1.${scope}`;
function restore(scope: string): TileLayout {
  try {
    return readTileLayout(window.sessionStorage.getItem(storageKey(scope)));
  } catch {
    return {};
  }
}
interface Presentation {
  readonly scope: string;
  readonly ids: readonly string[];
  readonly layout: TileLayout;
  readonly detached: readonly string[];
  readonly focused: string | undefined;
  readonly maximized: string | undefined;
}
function initial(scope: string, ids: readonly string[], layout: TileLayout): Presentation {
  return {
    scope,
    ids,
    layout: withOpenTools(layout, ids),
    detached: [],
    focused: ids.at(-1),
    maximized: undefined,
  };
}
function sync(current: Presentation, ids: readonly string[]): Presentation {
  if (ids.length === current.ids.length && ids.every((id, i) => id === current.ids[i]))
    return current;
  const added = ids.filter((id) => !current.ids.includes(id)).at(-1);
  const focused =
    added ??
    (current.focused === '' || (current.focused && ids.includes(current.focused))
      ? current.focused
      : ids.at(-1));
  return {
    ...current,
    ids,
    layout: withOpenTools(current.layout, ids),
    focused,
    detached: current.detached.filter((id) => ids.includes(id)),
    maximized:
      !added && current.maximized && ids.includes(current.maximized)
        ? current.maximized
        : undefined,
  };
}
function boundsStyle({ x, y, width, height }: Rect, inset = 0): CSSProperties {
  return { left: x, top: y + inset, width, height: Math.max(0, height - inset) };
}

function Divider({ boundary, adjust }: { boundary: Boundary; adjust: (value: number) => void }) {
  const t = useT();
  const drag = useRef<{ pointer: number; origin: number; value: number } | undefined>(undefined);
  const coord = (event: PointerEvent) => (boundary.axis === 'x' ? event.clientX : event.clientY);
  return (
    <div
      role="separator"
      className="tile-divider"
      data-axis={boundary.axis}
      tabIndex={0}
      data-testid={`tile-divider-${boundary.name}`}
      aria-orientation={boundary.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={t('tiles.resize')}
      aria-valuemin={Math.round(boundary.min)}
      aria-valuemax={Math.round(boundary.max)}
      aria-valuenow={Math.round(boundary.value)}
      style={boundsStyle(boundary.rect)}
      onDoubleClick={() => {
        adjust(boundary.extent / 2);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, origin: coord(event), value: boundary.value };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) adjust(start.value + coord(event) - start.origin);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        const dec = boundary.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const inc = boundary.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        let value: number;
        switch (event.key) {
          case dec:
            value = boundary.value - 16;
            break;
          case inc:
            value = boundary.value + 16;
            break;
          case 'Home':
            value = boundary.min;
            break;
          case 'End':
            value = boundary.max;
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        adjust(value);
      }}
    />
  );
}
interface Target {
  readonly id: string;
  readonly edge: Edge;
}
interface Drag {
  readonly source: string;
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  active: boolean;
  target?: Target | undefined;
}

export function ToolTiles({
  sessionId,
  openIds,
  renderPanel,
  titleOf,
  onClose,
  children,
}: ToolTilesProps) {
  const scope = sessionId ?? '';
  const remembered = useRef(new Map<string, TileLayout>());
  const [state, setState] = useState(() => initial(scope, openIds, restore(scope)));
  const current =
    state.scope === scope
      ? sync(state, openIds)
      : initial(scope, openIds, remembered.current.get(scope) ?? restore(scope));
  useLayoutEffect(
    () =>
      onPanelRequest((request) => {
        if (request.action !== 'show') return;
        const target = request.id === 'conversation' ? '' : request.id;
        setState((old) =>
          target !== '' && !old.ids.includes(target)
            ? old
            : {
                ...old,
                focused: target,
                maximized: target === old.maximized ? old.maximized : undefined,
              },
        );
      }),
    [],
  );
  if (current !== state) setState(current);
  useLayoutEffect(() => {
    remembered.current.set(scope, current.layout);
    if (!current.layout.tree) return;
    try {
      window.sessionStorage.setItem(storageKey(scope), JSON.stringify(current.layout));
    } catch {
      /* Retain the in-memory layout when the window cannot persist presentation state. */
    }
  }, [scope, current.layout]);
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(false);
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const measure = () => {
      const width = host.clientWidth,
        height = host.clientHeight;
      if (width && height)
        setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    setMeasured(true);
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);
  const content = useMemo(
    () => new Map(openIds.map((id) => [id, renderPanel(id)])),
    [openIds, renderPanel],
  );
  const docked = useMemo(
    () => openIds.filter((id) => !current.detached.includes(id)),
    [openIds, current.detached],
  );
  const geo = tileGeometry(
    current.layout,
    docked,
    size.width,
    size.height,
    current.focused,
    current.maximized,
  );
  const miniNav = geo.single && docked.length > 0 && !current.maximized;
  const menuItems = docked.map((id) => ({
    id,
    label: titleOf(id),
    selected: geo.panes.has(id),
    run: () => {
      setState((s) => ({ ...s, focused: id }));
    },
  }));
  const focusGrip = (id: string) =>
    requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLElement>(`[data-testid="tile-move-${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
    });
  const move = (from: string, target: Target) => {
    setState((s) =>
      s.layout.tree
        ? {
            ...s,
            layout: { ...s.layout, tree: moveTile(s.layout.tree, from, target.id, target.edge) },
            focused: from,
          }
        : s,
    );
    focusGrip(from);
  };
  const drag = useRef<Drag | undefined>(undefined);
  const keySource = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<Target>();
  const suppressClick = useRef(false);
  const cancelDrag = () => {
    drag.current = undefined;
    keySource.current = undefined;
    setDrop(undefined);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (drag.current || keySource.current) && !isImeComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancelDrag);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancelDrag);
    };
  }, []);
  const pointTarget = (event: PointerEvent, source: string): Target | undefined => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const x = event.clientX - box.left,
      y = event.clientY - box.top;
    for (const [id, rect] of geo.panes) {
      if (
        id !== source &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      )
        return { id, edge: dropEdge(rect, x, y) };
    }
    return;
  };
  const start = (event: PointerEvent<HTMLElement>, id: string) => {
    suppressClick.current = false;
    if (event.button !== 0 || geo.compact || current.maximized || current.detached.includes(id))
      return;
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(
            'button, input, select, textarea, [role="tab"], [role="menuitem"], [contenteditable="true"]',
          )
        : null;
    if (button && !button.hasAttribute('data-tile-grip')) return;
    drag.current = {
      source: id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
    // Capture on the original target so a short click still reaches the handle button.
    (button ?? event.currentTarget).setPointerCapture(event.pointerId);
  };
  const update = (event: PointerEvent<HTMLElement>) => {
    const action = drag.current;
    if (action?.pointer !== event.pointerId || event.buttons === 0) return;
    if (!action.active && Math.hypot(event.clientX - action.x, event.clientY - action.y) < 16)
      return;
    if (!action.active) {
      action.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      suppressClick.current = true;
    }
    action.target = pointTarget(event, action.source);
    const next = action.target;
    setDrop((old) => (old?.id === next?.id && old?.edge === next?.edge ? old : next));
  };
  const finish = (event: PointerEvent) => {
    const action = drag.current;
    if (action?.pointer !== event.pointerId) return;
    if (action.active) {
      const outside =
        event.clientX < -16 ||
        event.clientX > window.innerWidth + 16 ||
        event.clientY < -16 ||
        event.clientY > window.innerHeight + 16;
      if (outside) {
        setState((s) => ({
          ...s,
          detached: [...new Set([...s.detached, action.source])],
          maximized: undefined,
        }));
      } else {
        const to = pointTarget(event, action.source);
        if (to) move(action.source, to);
      }
    }
    cancelDrag();
  };
  const previewKey = (id: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === 'Enter' && keySource.current === id && drop) {
      event.preventDefault();
      move(id, drop);
      cancelDrag();
      return;
    }
    const edges: Record<string, Edge> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'above',
      ArrowDown: 'below',
    };
    const edge = edges[event.key];
    const origin = geo.panes.get(id);
    if (!edge || !origin) return;
    const horizontal = edge === 'left' || edge === 'right';
    const sign = edge === 'left' || edge === 'above' ? -1 : 1;
    let best: string | undefined;
    let minimum = Infinity;
    for (const [other, r] of geo.panes) {
      if (id === other) continue;
      const dx = r.x + r.width / 2 - origin.x - origin.width / 2;
      const dy = r.y + r.height / 2 - origin.y - origin.height / 2;
      const forward = (horizontal ? dx : dy) * sign;
      const distance = Math.hypot(dx, dy) + (forward <= 0 ? size.width + size.height : 0);
      if (distance < minimum) {
        best = other;
        minimum = distance;
      }
    }
    if (best === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    keySource.current = id;
    setDrop({ id: best, edge });
  };
  const dropRect = drop ? geo.panes.get(drop.id) : undefined;
  const selectMenu = (includeMain: boolean) => (
    <ChoiceButton
      label={t('tiles.switch')}
      valueLabel={
        geo.main && !geo.panes.size ? t('tiles.chat') : titleOf(geo.active ?? docked[0] ?? '')
      }
      testId="tile-switch"
      items={
        includeMain
          ? [
              {
                id: 'conversation',
                label: t('tiles.chat'),
                selected: geo.panes.size === 0,
                run: () => {
                  setState((s) => ({ ...s, focused: '' }));
                },
              },
              ...menuItems,
            ]
          : menuItems
      }
      above={false}
    >
      {geo.main && !geo.panes.size ? t('tiles.chat') : titleOf(geo.active ?? docked[0] ?? '')}
      <ChevronDownIcon />
    </ChoiceButton>
  );
  return (
    <div
      ref={root}
      className="tool-tiles"
      data-testid="tool-tiles"
      data-has-tools={docked.length > 0}
      data-compact={geo.compact}
      data-mini-nav={miniNav}
      onPointerMove={update}
      onPointerUp={finish}
      onPointerCancel={cancelDrag}
    >
      {miniNav && (
        <nav className="tile-mini-nav" aria-label={t('tiles.switch')}>
          {selectMenu(true)}
        </nav>
      )}
      <div
        className="tile-primary"
        data-testid="tile-primary"
        hidden={!geo.main}
        style={geo.main ? boundsStyle(geo.main, miniNav ? 32 : 0) : undefined}
      >
        {children}
      </div>
      {measured &&
        openIds.map((id) => {
          const rect = geo.panes.get(id);
          const detached = current.detached.includes(id);
          const expanded = current.maximized === id;
          const customHeader = ['terminal', 'side-chat', 'files', 'changes', 'preview'].includes(id);
          const showPicker =
            geo.compact && !geo.single && !detached && !expanded && docked.length > 1;
          const dock = () => {
            setState((s) =>
              s.detached.includes(id)
                ? { ...s, detached: s.detached.filter((entry) => entry !== id), focused: id }
                : s,
            );
          };
          return (
            <div
              className="tool-tile-slot"
              key={scope + '\u0000' + id}
              hidden={!rect}
              style={rect ? boundsStyle(rect, miniNav ? 32 : 0) : undefined}
              data-compact-caption={rect !== undefined && rect.width < 380}
              data-window-top={!miniNav && rect?.y === 0}
              data-top-left={!miniNav && rect?.x === 0 && rect.y === 0}
              data-overlay-edge={!miniNav && rect?.y === 0 && rect.x + rect.width === size.width}
            >
              <PopoutSurface
                sessionId={scope}
                panelId={id}
                title={titleOf(id)}
                detached={detached}
                onDock={dock}
              >
                <ToolHeaderProvider visible={detached || rect !== undefined}>
                  <section
                    className="tool-tile"
                    data-testid={`tile-${id}`}
                    aria-label={t('tiles.paneLabel', { title: titleOf(id) })}
                    data-tile-id={id}
                    data-maximized={expanded}
                    data-detached={detached}
                  >
                    {detached && <h1 className="visually-hidden">{titleOf(id)}</h1>}
                    <header
                      className="tool-tile-header"
                      data-testid={`tile-header-${id}`}
                      onPointerDown={(event) => {
                        start(event, id);
                      }}
                    >
                      {!detached && (
                        <MoveButton
                          id={id}
                          ids={docked}
                          titleOf={titleOf}
                          suppressed={suppressClick}
                          onMove={(to) => {
                            move(id, to);
                          }}
                          onPreview={(event) => {
                            previewKey(id, event);
                          }}
                          onCancelPreview={cancelDrag}
                          disabled={docked.length < 2 || expanded}
                        />
                      )}
                      {showPicker && selectMenu(false)}
                      {customHeader ? (
                        <ToolHeaderTarget />
                      ) : (
                        !showPicker && <h2 className="tool-tile-title">{titleOf(id)}</h2>
                      )}
                      <div className="tool-tile-actions" data-popout-actions>
                        <ToolWindowPin />
                        {sessionId && (
                          <IconButton
                            data-testid={`tile-popout-${id}`}
                            label={t(detached ? 'tiles.dock' : 'tiles.popOut')}
                            onClick={() => {
                              if (detached) dock();
                              else
                                setState((s) => ({
                                  ...s,
                                  detached: [...s.detached, id],
                                  maximized: undefined,
                                }));
                            }}
                          >
                            <PopoutIcon />
                          </IconButton>
                        )}
                        {!detached && (
                          <IconButton
                            data-testid={`tile-maximize-${id}`}
                            label={t(expanded ? 'tiles.restore' : 'tiles.maximize')}
                            aria-pressed={expanded}
                            onClick={() => {
                              setState((s) => ({
                                ...s,
                                focused: id,
                                maximized: expanded ? undefined : id,
                              }));
                            }}
                          >
                            {expanded ? <MinimizeIcon /> : <MaximizeIcon />}
                          </IconButton>
                        )}
                        <IconButton
                          data-testid={`tile-close-${id}`}
                          label={t('panels.close')}
                          onClick={() => {
                            onClose(id);
                          }}
                        >
                          <CloseIcon />
                        </IconButton>
                      </div>
                    </header>
                    <div className="tool-tile-body" data-testid={`tile-body-${id}`}>
                      {content.get(id)}
                    </div>
                  </section>
                </ToolHeaderProvider>
              </PopoutSurface>
            </div>
          );
        })}
      {geo.boundaries.length > 0 && (
        <div role="region" aria-label={t('tiles.resize')}>
          {geo.boundaries.map((b) => (
            <Divider
              key={b.key}
              boundary={b}
              adjust={(position) => {
                setState((s) => ({ ...s, layout: resizeTiles(s.layout, b, position) }));
              }}
            />
          ))}
        </div>
      )}
      {keySource.current && drop && (
        <div className="visually-hidden" role="status">
          {t(`tiles.${drop.edge}`, { panel: titleOf(drop.id) })}
        </div>
      )}
      {drop && dropRect && (
        <div
          className="tile-drop-zone"
          data-testid="tile-drop-zone"
          data-edge={drop.edge}
          style={boundsStyle(dropRect)}
          aria-hidden="true"
        >
          <div />
        </div>
      )}
    </div>
  );
}

function MoveButton({
  id,
  ids,
  titleOf,
  suppressed,
  onPreview,
  onCancelPreview,
  onMove,
  disabled,
}: {
  readonly id: string;
  readonly ids: readonly string[];
  readonly titleOf: (id: string) => string;
  readonly suppressed: { current: boolean };
  readonly onPreview: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onCancelPreview: () => void;
  readonly onMove: (target: Target) => void;
  readonly disabled: boolean;
}) {
  const menu = useMenu();
  const t = useT();
  return (
    <>
      <IconButton
        data-testid={`tile-move-${id}`}
        data-tile-grip=""
        aria-description={t('tiles.moveHint')}
        onKeyDown={onPreview}
        onBlur={onCancelPreview}
        label={t('tiles.move')}
        disabled={disabled}
        aria-expanded={menu.open !== null}
        aria-haspopup="menu"
        onClick={(event) => {
          if (suppressed.current && event.detail > 0) {
            suppressed.current = false;
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          menu.openAt(box.left, box.bottom + 4);
        }}
      >
        <GripIcon />
      </IconButton>
      {menu.open && (
        <MenuPopup
          at={menu.open}
          onClose={menu.close}
          label={t('tiles.move')}
          items={ids
            .filter((other) => id !== other)
            .flatMap((other) =>
              EDGES.map((edge) => ({
                id: `move-${other}-${edge}`,
                label: t(`tiles.${edge}`, { panel: titleOf(other) }),
                run: () => {
                  onMove({ id: other, edge });
                },
              })),
            )}
        />
      )}
    </>
  );
}
