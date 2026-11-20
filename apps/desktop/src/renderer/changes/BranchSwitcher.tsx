// Switching between branches (T28, architecture section 6.9): on a user message that has sibling
// branches, "‹ 2 / 3 ›" moves to the previous or next one; above the input, after a rewind with
// nothing sent yet, the branches that continue from here. Switching asks Core, which reopens
// the session on that branch; the transcript and task list reload.
import type { BranchPoint } from '@piarc/protocol';

import { useT } from '../app/app-context.js';

export function BranchSwitcher({
  point,
  onSwitch,
  disabled,
}: {
  readonly point: BranchPoint;
  readonly onSwitch: (entryId: string) => void;
  readonly disabled: boolean;
}) {
  const t = useT();
  const index = point.index ?? 0;
  const count = point.options.length;
  const previous = point.options[index - 1];
  const next = point.options[index + 1];
  return (
    <span
      className="branch-switcher"
      data-testid="branch-switcher"
      role="group"
      aria-label={t('branches.position', { index: index + 1, count })}
    >
      <button
        type="button"
        className="row-action"
        data-testid="branch-previous"
        aria-label={t('branches.previous')}
        title={previous?.preview}
        disabled={disabled || previous === undefined}
        onClick={() => {
          if (previous !== undefined) onSwitch(previous.entryId);
        }}
      >
        ‹
      </button>
      <span className="branch-position" data-testid="branch-position">
        {index + 1} / {count}
      </span>
      <button
        type="button"
        className="row-action"
        data-testid="branch-next"
        aria-label={t('branches.next')}
        title={next?.preview}
        disabled={disabled || next === undefined}
        onClick={() => {
          if (next !== undefined) onSwitch(next.entryId);
        }}
      >
        ›
      </button>
    </span>
  );
}

/** Above the input after a rewind: the branches that continue from where the conversation is. */
export function BranchTail({
  point,
  onSwitch,
  disabled,
}: {
  readonly point: BranchPoint;
  readonly onSwitch: (entryId: string) => void;
  readonly disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="branch-tail" data-testid="branch-tail" role="note">
      <span className="muted">{t('branches.tail')}</span>
      <ul>
        {point.options.map((option) => (
          <li key={option.entryId}>
            <span className="branch-preview truncate">{option.preview}</span>
            <button
              type="button"
              className="row-action"
              data-testid="branch-tail-switch"
              disabled={disabled}
              onClick={() => {
                onSwitch(option.entryId);
              }}
            >
              {t('branches.switch')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
