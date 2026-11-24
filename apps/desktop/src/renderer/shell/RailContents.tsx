// Session details form a single scrollable column. Disclosure state and order belong to the
// window layout; the session data inside each section continues to follow its Core store.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSession } from '../store/hooks.js';
import { ChevronDownIcon, ComputerIcon, FolderIcon, GripIcon } from './icons.js';
import {
  moveRailSection,
  railOrder,
  readRailPreferences,
  saveRailPreferences,
} from './rail-order.js';
import { useRequestedPanel, type PanelContext, type PanelSpec } from './registry.js';
import { baseName } from './ui.js';

function Environment({ sessionId }: { sessionId: string | undefined }) {
  const t = useT();
  const session = useSession(sessionId);
  const folder = session?.worktreePath ?? session?.cwd ?? session?.workspace;
  return (
    <>
      <div className="rail-environment-row">
        <ComputerIcon />
        <span>{t('workbench.local')}</span>
      </div>
      {folder && (
        <div className="rail-environment-row" title={folder}>
          <FolderIcon />
          <span>{baseName(folder)}</span>
          <small dir="auto">{folder}</small>
        </div>
      )}
    </>
  );
}

const environment: PanelSpec = {
  id: 'environment',
  title: 'panels.environment',
  initiallyExpanded: true,
  area: 'rail',
  order: 0,
  render: (context) => <Environment sessionId={context.sessionId} />,
};

interface Move {
  readonly from: string;
  readonly to: string;
  readonly pointerDrag: boolean;
}

export function RailContents({
  context,
  registered,
  handled,
}: {
  context: PanelContext;
  registered: readonly PanelSpec[];
  handled: RefObject<ReturnType<typeof useRequestedPanel>>;
}) {
  const t = useT();
  const groupId = useId();
  const [preferences, setPreferences] = useState(readRailPreferences);
  const [move, setMove] = useState<Move | null>(null);
  const [announcement, announce] = useState('');
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const request = useRequestedPanel();
  const sections = new Map(
    [environment, ...registered.filter((p) => p.area === 'rail')].map((panel) => [panel.id, panel]),
  );
  const order = railOrder([...sections.keys()], preferences.order);
  const content = order.flatMap((id) => {
    const panel = sections.get(id);
    return panel && (panel.when?.(context) ?? true) ? [panel] : [];
  });
  const visible = content.map((panel) => panel.id);
  useEffect(() => {
    saveRailPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!request || handled.current === request) return;
    const heading = handles.current.get(request.id)?.closest('.rail-heading');
    if (!heading) return;
    handled.current = request;
    setPreferences((current) =>
      current.expanded[request.id] === true
        ? current
        : {
            ...current,
            expanded: { ...current.expanded, [request.id]: true },
          },
    );
    heading.scrollIntoView({ block: 'nearest' });
  }, [request, handled, context]);
  const position = (from: string, to: string, done: boolean) => {
    const section = sections.get(from);
    if (!section) return;
    announce(
      t(done ? 'rail.placed' : 'rail.position', {
        name: t(section.title),
        position: visible.indexOf(to) + 1,
        count: visible.length,
      }),
    );
  };
  const place = (from: string, to: string) => {
    setPreferences((current) => ({ ...current, order: moveRailSection(order, visible, from, to) }));
    setMove(null);
    position(from, to, true);
    requestAnimationFrame(() => handles.current.get(from)?.focus({ preventScroll: true }));
  };
  const pick = (id: string) => {
    if (move) {
      place(move.from, move.from === id ? move.to : id);
    } else {
      setMove({ from: id, to: id, pointerDrag: false });
      position(id, id, false);
    }
  };
  const cancel = () => {
    setMove(null);
    announce(t('rail.cancelled'));
  };
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!move || move.pointerDrag || isImeComposing(event.nativeEvent)) return;
    const index = visible.indexOf(move.to);
    const next =
      event.key === 'ArrowUp'
        ? visible[index - 1]
        : event.key === 'ArrowDown'
          ? visible[index + 1]
          : undefined;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!next) return;
    setMove({ ...move, to: next });
    position(move.from, next, false);
    handles.current.get(next)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <div
      className="panel-body rail-sections"
      onKeyDown={(event) => {
        if (!move || event.key !== 'Escape' || isImeComposing(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      onBlur={(event) => {
        if (move && !move.pointerDrag && !event.currentTarget.contains(event.relatedTarget))
          cancel();
      }}
    >
      <span className="visually-hidden" id={groupId + '-reorder-hint'}>
        {t('rail.reorderHint')}
      </span>
      <span className="visually-hidden" role="status" aria-atomic="true">
        {announcement}
      </span>
      {content.map((panel, index) => {
        const id = panel.id;
        const title = t(panel.title);
        const expanded = preferences.expanded[id] ?? panel.initiallyExpanded ?? false;
        const headerId = groupId + '-' + id;
        const target = move?.to === id && move.from !== id;
        return (
          <section
            key={id}
            className="rail-section"
            data-section={id}
            data-dragging={move?.from === id || undefined}
            data-insertion={
              target ? (visible.indexOf(move.from) < index ? 'after' : 'before') : undefined
            }
            onDragOver={(event) => {
              if (!move?.pointerDrag) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              if (move.to !== id) setMove({ ...move, to: id });
            }}
            onDrop={(event) => {
              if (!move?.pointerDrag) return;
              event.preventDefault();
              event.stopPropagation();
              place(move.from, id);
            }}
          >
            <div className="rail-heading">
              <h2>
                <button
                  type="button"
                  id={headerId}
                  data-testid={'panel-tab-' + id}
                  aria-expanded={expanded}
                  aria-controls={headerId + '-body'}
                  onClick={() => {
                    setMove(null);
                    setPreferences((current) => ({
                      ...current,
                      expanded: { ...current.expanded, [id]: !expanded },
                    }));
                  }}
                >
                  {title}
                  <ChevronDownIcon />
                </button>
              </h2>
              <IconButton
                className="rail-grip"
                label={t('rail.reorder', { name: title })}
                aria-describedby={groupId + '-reorder-hint'}
                aria-pressed={move?.from === id}
                ref={(el) => {
                  if (el) handles.current.set(id, el);
                  else handles.current.delete(id);
                }}
                draggable
                data-testid={'rail-reorder-' + id}
                onClick={() => {
                  pick(id);
                }}
                onKeyDown={handleKey}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-piarc-rail-section', id);
                  const heading = event.currentTarget.closest('.rail-heading');
                  if (heading)
                    event.dataTransfer.setDragImage(
                      heading,
                      heading.clientWidth - 12,
                      heading.clientHeight / 2,
                    );
                  setMove({ from: id, to: id, pointerDrag: true });
                }}
                onDragEnd={() => {
                  setMove(null);
                }}
              >
                <GripIcon />
              </IconButton>
            </div>
            <div
              id={headerId + '-body'}
              className="rail-section-body"
              hidden={!expanded}
              role="group"
              aria-labelledby={headerId}
            >
              {expanded && panel.render(context)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
