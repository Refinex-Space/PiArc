// The tray of picked elements under the page (B3.1, B3.6): one numbered card per pick with its
// selector, component, source location, thumbnail and a comment box; "Open in Files" jumps to the
// source line, "Copy selector" copies it. "Add to conversation (N)" hands every card to the
// session's input as one group. Card text is page data: shown as text with bidi controls revealed.
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon, CopyGlyph, FileCodeCornerIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';
import { elementTitle, sourceText } from './context-items.js';
import type { TrayCard } from './picks.js';

export function PickTray({
  cards,
  picking,
  onComment,
  onRemove,
  onClear,
  onDone,
  onAdd,
  onOpenSource,
  onCopySelector,
}: {
  readonly cards: readonly TrayCard[];
  /** The picker is on (shows "Done"). */
  readonly picking: boolean;
  readonly onComment: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  readonly onDone: () => void;
  readonly onAdd: () => void;
  readonly onOpenSource: (card: TrayCard) => void;
  readonly onCopySelector: (card: TrayCard) => void;
}) {
  const t = useT();
  return (
    <section
      id="browser-picks"
      className="browser-picks"
      data-testid="browser-picks"
      aria-label={t('browser.picks.title')}
    >
      <div className="browser-picks-head">
        <span className="browser-picks-title">
          {picking ? t('browser.picks.picking') : t('browser.picks.title')}
        </span>
        <div className="browser-picks-actions">
          {cards.length > 0 && (
            <Button
              variant="ghost"
              size="small"
              data-testid="browser-picks-clear"
              onClick={onClear}
            >
              {t('browser.picks.clear')}
            </Button>
          )}
          {picking && (
            <Button size="small" data-testid="browser-picks-done" onClick={onDone}>
              {t('browser.picks.done')}
            </Button>
          )}
          <Button
            variant="primary"
            size="small"
            data-testid="browser-picks-add"
            disabled={cards.length === 0}
            onClick={onAdd}
          >
            {t('browser.picks.add', { count: cards.length })}
          </Button>
        </div>
      </div>
      {cards.length === 0 ? (
        <p className="browser-picks-empty">{t('browser.picks.hint')}</p>
      ) : (
        <ol className="browser-picks-list">
          {cards.map((card, index) => (
            <PickCard
              key={card.pick.id}
              n={index + 1}
              card={card}
              onComment={onComment}
              onRemove={onRemove}
              onOpenSource={onOpenSource}
              onCopySelector={onCopySelector}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function PickCard({
  n,
  card,
  onComment,
  onRemove,
  onOpenSource,
  onCopySelector,
}: {
  readonly n: number;
  readonly card: TrayCard;
  readonly onComment: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onOpenSource: (card: TrayCard) => void;
  readonly onCopySelector: (card: TrayCard) => void;
}) {
  const t = useT();
  const { context, image, id } = card.pick;
  const source = sourceText(context);
  const component = context.components[0];
  const title = revealBidi(elementTitle(context));
  const commentId = `browser-pick-comment-${id}`;
  return (
    <li className="browser-pick" data-testid="browser-pick-card" data-pick={id}>
      <span className="browser-pick-number" aria-hidden="true">
        {n}
      </span>
      {image !== undefined && (
        <img
          className="browser-pick-thumb"
          src={image.data}
          alt=""
          width={image.width}
          height={image.height}
          data-testid="browser-pick-thumb"
        />
      )}
      <div className="browser-pick-body">
        <p className="browser-pick-title">
          <span className="visually-hidden">{t('browser.picks.number', { n })} </span>
          {title}
        </p>
        <code className="browser-pick-selector" data-testid="browser-pick-selector">
          {revealBidi(context.selector)}
        </code>
        {component !== undefined && (
          <p className="browser-pick-component" data-testid="browser-pick-component">
            {revealBidi(context.components.join(' ‹ '))}
          </p>
        )}
        {source !== undefined && (
          <button
            type="button"
            className="browser-pick-source"
            data-testid="browser-pick-source"
            data-tooltip={t('browser.picks.openSource')}
            onClick={() => {
              onOpenSource(card);
            }}
          >
            <FileCodeCornerIcon size={12} />
            <span>{source}</span>
          </button>
        )}
        <label className="visually-hidden" htmlFor={commentId}>
          {t('browser.picks.comment', { n })}
        </label>
        <textarea
          id={commentId}
          className="browser-pick-comment"
          data-testid="browser-pick-comment"
          rows={1}
          placeholder={t('browser.picks.commentPlaceholder')}
          value={card.comment}
          onChange={(event) => {
            onComment(id, event.target.value);
          }}
        />
      </div>
      <div className="browser-pick-tools">
        <IconButton
          size="xs"
          label={t('browser.picks.copySelector')}
          data-testid="browser-pick-copy"
          onClick={() => {
            onCopySelector(card);
          }}
        >
          <CopyGlyph size={12} />
        </IconButton>
        <IconButton
          size="xs"
          label={t('browser.picks.remove', { n })}
          data-testid="browser-pick-remove"
          onClick={() => {
            onRemove(id);
          }}
        >
          <CloseIcon size={12} />
        </IconButton>
      </div>
    </li>
  );
}
