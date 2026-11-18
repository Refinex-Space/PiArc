// The queued inputs above the composer (architecture section 8.2): steering messages waiting for
// the current step and follow-ups waiting for the turn to end, each editable and removable until
// the model gets it. The queue itself is Core's (`session/queueChanged`).
import { useState } from 'react';

import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import type { QueuedInput } from '../store/transcript.js';
import { AttachmentChips } from '../transcript/rows/common.js';

function QueueEntry({
  item,
  onEdit,
  onDelete,
}: {
  readonly item: QueuedInput;
  readonly onEdit: (itemId: string, text: string) => void;
  readonly onDelete: (itemId: string) => void;
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
      className="queue-item"
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
      <span className="queue-actions">
        {editing === undefined ? (
          <button
            type="button"
            className="row-action"
            data-testid="queue-edit"
            onClick={() => {
              setEditing(item.text);
            }}
          >
            {t('composer.queue.edit')}
          </button>
        ) : (
          <>
            <button type="button" className="row-action" data-testid="queue-save" onClick={save}>
              {t('composer.queue.save')}
            </button>
            <button
              type="button"
              className="row-action"
              onClick={() => {
                setEditing(undefined);
              }}
            >
              {t('composer.queue.cancel')}
            </button>
          </>
        )}
        <button
          type="button"
          className="row-action"
          data-testid="queue-delete"
          onClick={() => {
            onDelete(item.itemId);
          }}
        >
          {t('composer.queue.delete')}
        </button>
      </span>
    </li>
  );
}

export function QueueList({
  items,
  onEdit,
  onDelete,
}: {
  readonly items: readonly QueuedInput[];
  readonly onEdit: (itemId: string, text: string) => void;
  readonly onDelete: (itemId: string) => void;
}) {
  const t = useT();
  return (
    <ul className="queue-list" data-testid="queue-list" aria-label={t('composer.queue.label')}>
      {items.map((item) => (
        <QueueEntry key={item.itemId} item={item} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </ul>
  );
}
