import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useT } from '../../app/app-context.js';
import { ExpandIcon } from '../../shell/icons.js';
import { MediaViewer } from './MediaViewer.js';
import type { MediaSize } from './media-camera.js';
import { bindMediaThumbnail } from './media-context-item.js';
import { useInlineDiagram } from './inline-diagram.js';
export function MediaTrigger({
  src,
  label,
  kind,
  natural,
  editing = false,
  onError,
  onOpenChange,
}: {
  src: string;
  label: string;
  kind: 'image' | 'diagram';
  natural?: MediaSize | undefined;
  editing?: boolean;
  onError?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT(),
    trigger = useRef<HTMLButtonElement | null>(null),
    surface = useRef<HTMLSpanElement>(null),
    [opened, setOpen] = useState(false);
  const inlineZoom = useInlineDiagram(surface, kind === 'diagram' && !editing, src);
  const name = t('files.md.zoomImage', { name: label });
  const restoreFocus = useRef<(() => void) | undefined>(undefined);
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  const show = (button: HTMLButtonElement, restore?: () => void) => {
    trigger.current = button;
    restoreFocus.current = restore;
    button.focus({ preventScroll: true });
    setOpen(true);
    notify.current?.(true);
  };
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    show(e.currentTarget);
  };
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    return bindMediaThumbnail(node, {
      kind,
      open: (restore) => {
        const button = node.querySelector('button');
        if (button) show(button, restore);
      },
    });
  }, [kind, src]);
  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
    // The document's active element is the CM host when the trigger is in a shadow tree.
    // Return the focus to that actual button after the modal's normal focus cleanup.
    const button = trigger.current;
    button?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (button.isConnected) {
        if (restoreFocus.current) restoreFocus.current();
        else button.focus({ preventScroll: true });
      }
    });
  };
  const picture = (
    <img
      alt={label}
      src={src}
      width={natural?.width}
      height={natural?.height}
      onError={onError}
      draggable={false}
    />
  );
  return (
    <>
      <span
        ref={surface}
        className={'md-media-thumb' + (kind === 'diagram' ? ' md-chart-thumb' : '')}
      >
        {editing ? (
          <>
            {picture}
            <button
              type="button"
              className={
                'md-media-expand ' +
                (kind === 'diagram' ? 'markdown-diagram-open' : 'markdown-image-open')
              }
              aria-label={name}
              title={name}
              aria-haspopup="dialog"
              onClick={open}
            >
              <ExpandIcon />
            </button>
          </>
        ) : (
          <button
            type="button"
            className={
              'md-media-photo-button ' +
              (kind === 'diagram' ? 'markdown-diagram-open' : 'markdown-image-open')
            }
            aria-label={name}
            title={name}
            aria-haspopup="dialog"
            onClick={(e) => {
              const el = e.target as Element;
              if (e.detail === 0 || inlineZoom.current === 1 || el.closest('.md-media-expand'))
                open(e);
            }}
          >
            {picture}
            <span className="md-media-expand" aria-hidden="true">
              <ExpandIcon />
            </span>
          </button>
        )}
      </span>
      {opened && (
        <MediaViewer
          src={src}
          label={label}
          kind={kind}
          {...(natural ? { natural } : {})}
          onClose={close}
        />
      )}
    </>
  );
}
