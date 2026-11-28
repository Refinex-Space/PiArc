// The queued inputs above the composer (architecture section 8.2): steering messages waiting for
// the current step and follow-ups waiting for the turn to end, each editable and removable until
// the model gets it. The queue itself is Core's (`session/queueChanged`). One quiet band: a count
// that folds the list away, then a row per input with its actions on hover or focus. While a turn
// runs, a follow-up can be sent now: it leaves the queue and steers the turn (the reference's
// "Send now", one at a time).
import { useState } from 'react';

import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import type { QueuedInput } from '../store/transcript.js';
import { AttachmentChips } from '../transcript/rows/common.js';
import { StepCaret, CloseGlyph, CheckGlyph, PencilIcon, SendIcon } from './icons.js';

/** "Send now" for the queue: offered while a turn runs; `busy` while one is being sent. */
export interface QueueSendNow {
  readonly send: (item: QueuedInput) => void;
  readonly busy: boolean;
}

function QueueEntry({
  item,
  onEdit,
  onDelete,
  sendNow,
}: {
  readonly item: QueuedInput;
  readonly onEdit: (itemId: string, text: string) => void;
  readonly onDelete: (itemId: string) => void;
  readonly sendNow: QueueSendNow | undefined;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const save = (): void => {
    if (editing !== undefined && editing.trim() !== '' && editing !== item.text) {
      onEdit(item.itemId, editing);
    }
    setEditing(undefined);
  };
  return (
    <li
      className={`queue-item${editing === undefined ? '' : ' is-editing'}`}
      data-testid="queue-item"
      data-kind={item.kind}
      data-item-id={item.itemId}
    >
      <span className={`queue-kind is-${item.kind}`}>
        {t(item.kind === 'steer' ? 'composer.queue.steer' : 'composer.queue.followUp')}
      </span>
      {editing === undefined ? (
        <span className="queue-text" data-testid="queue-text">
          {item.text}
        </span>
      ) : (
        <textarea
          className="input queue-editor"
          data-testid="queue-editor"
          value={editing}
          rows={Math.min(6, editing.split('\n').length)}
          aria-label={t('composer.queue.edit')}
          ref={(element) => {
            element?.focus();
          }}
          onChange={(event) => {
            setEditing(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) {
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(undefined);
            }
          }}
        />
      )}
      <AttachmentChips attachments={item.attachments} />
      <span
        className={`queue-actions${editing === undefined ? ' reveal-actions' : ''}`}
        data-pinned={editing !== undefined}
      >
        {/* A steering message already goes in after the current step: only follow-ups. */}
        {editing === undefined && sendNow !== undefined && item.kind === 'followUp' ? (
          <IconButton
            label={t('composer.queue.sendNow')}
            size="xs"
            data-testid="queue-send-now"
            disabled={sendNow.busy}
            onClick={() => {
              sendNow.send(item);
            }}
          >
            <SendIcon />
          </IconButton>
        ) : null}
        {editing === undefined ? (
          <IconButton
            label={t('composer.queue.edit')}
            size="xs"
            data-testid="queue-edit"
            onClick={() => {
              setEditing(item.text);
            }}
          >
            <PencilIcon />
          </IconButton>
        ) : (
          <>
            <IconButton
              label={t('composer.queue.save')}
              size="xs"
              data-testid="queue-save"
              onClick={save}
            >
              <CheckGlyph />
            </IconButton>
            <IconButton
              label={t('composer.queue.cancel')}
              size="xs"
              onClick={() => {
                setEditing(undefined);
              }}
            >
              <CloseGlyph />
            </IconButton>
          </>
        )}
        {editing === undefined ? (
          <IconButton
            label={t('composer.queue.delete')}
            size="xs"
            data-testid="queue-delete"
            onClick={() => {
              onDelete(item.itemId);
            }}
          >
            <CloseGlyph />
          </IconButton>
        ) : null}
      </span>
    </li>
  );
}

export function QueueList({
  items,
  onEdit,
  onDelete,
  sendNow,
}: {
  readonly items: readonly QueuedInput[];
  readonly onEdit: (itemId: string, text: string) => void;
  readonly onDelete: (itemId: string) => void;
  /** Present while a turn runs. */
  readonly sendNow?: QueueSendNow | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const next = items[0];
  return (
    <section className="queue-band" data-testid="queue-band" data-open={open}>
      <button
        type="button"
        className="queue-head"
        aria-expanded={open}
        data-testid="queue-toggle"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="queue-count">{t('composer.queue.count', { count: items.length })}</span>
        {!open && next !== undefined ? <span className="queue-next">{next.text}</span> : null}
        <span className="queue-caret" aria-hidden="true">
          <StepCaret />
        </span>
      </button>
      {open ? (
        <ul className="queue-list" data-testid="queue-list" aria-label={t('composer.queue.label')}>
          {items.map((item) => (
            <QueueEntry
              key={item.itemId}
              item={item}
              onEdit={onEdit}
              onDelete={onDelete}
              sendNow={sendNow}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
