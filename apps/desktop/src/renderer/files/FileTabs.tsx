import { useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../app/app-context.js';
import { CloseIcon } from '../shell/icons.js';
import type { FileTabs as Tabs } from './file-tabs.js';
import type { FileMenuPoint } from './FileActionsMenu.js';
export function FileTabStrip({
  tabs,
  dirty,
  select,
  keep,
  close,
  menu,
  reorder,
}: {
  tabs: Tabs;
  dirty: ReadonlySet<string>;
  select: (p: string) => void;
  keep: (p: string) => void;
  close: (p: string) => void;
  menu: (p: string, at: FileMenuPoint) => void;
  reorder: (from: string, to: string) => void;
}) {
  const t = useT(),
    strip = useRef<HTMLDivElement>(null),
    moving = useRef<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, i: number, path: string) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (keys.includes(event.key)) {
      const last = tabs.paths.length - 1;
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : (i + (event.key === 'ArrowRight' ? 1 : -1) + last + 1) % (last + 1);
      const next = tabs.paths[index];
      if (next) {
        event.preventDefault();
        select(next);
        strip.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[index]?.focus();
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      close(path);
    } else if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      const el = event.currentTarget,
        b = el.getBoundingClientRect();
      menu(path, { x: b.left, y: b.bottom, anchor: el });
    }
  }
  return (
    <div
      className="files-tab-viewport"
      onPointerLeave={() => {
        setHovered(null);
      }}
    >
      <div
        className="files-tabs-grid"
        style={{ gridTemplateColumns: 'repeat(' + String(tabs.paths.length) + ',max-content)' }}
      >
        <div ref={strip} className="files-tabs" role="tablist" aria-label={t('files.tabs')}>
          {tabs.paths.map((p, i) => {
            const name = p.split('/').at(-1) ?? p,
              duplicate = tabs.paths.some((q) => q !== p && q.endsWith('/' + name));
            return (
              <div
                key={p}
                className="files-tab"
                role="presentation"
                onPointerEnter={() => {
                  setHovered(p);
                }}
                data-selected={tabs.active === p}
                data-preview={tabs.preview === p}
                onContextMenu={(e) => {
                  e.preventDefault();
                  menu(p, { x: e.clientX, y: e.clientY });
                }}
                draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  moving.current = p;
                  e.dataTransfer.setData('application/x-piarc-file-tab', p);
                }}
                onDragEnd={() => {
                  moving.current = null;
                }}
                onDragOver={(e) => {
                  if (moving.current) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (moving.current) {
                    e.preventDefault();
                    reorder(moving.current, p);
                    moving.current = null;
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    close(p);
                  }
                }}
              >
                <button
                  role="tab"
                  id={'file-tab-' + encodeURIComponent(p)}
                  aria-controls={'file-content-' + encodeURIComponent(p)}
                  aria-keyshortcuts="Delete Backspace"
                  type="button"
                  aria-selected={tabs.active === p}
                  tabIndex={tabs.active === p ? 0 : -1}
                  title={p}
                  onKeyDown={(e) => {
                    navigate(e, i, p);
                  }}
                  onClick={() => {
                    select(p);
                  }}
                  onDoubleClick={() => {
                    keep(p);
                  }}
                >
                  {duplicate ? p : name}
                  {dirty.has(p) && <span aria-label={t('files.modified')}> ●</span>}
                </button>
              </div>
            );
          })}
        </div>
        {tabs.paths.map((p, i) => (
          <button
            key={p}
            className="files-tab-close"
            type="button"
            aria-label={t('files.closeFile', { name: p.split('/').at(-1) ?? p })}
            data-shown={tabs.active === p || hovered === p}
            onPointerEnter={() => {
              setHovered(p);
            }}
            style={{ gridColumn: i + 1 }}
            onClick={() => {
              close(p);
            }}
          >
            <CloseIcon />
          </button>
        ))}
      </div>
    </div>
  );
}
