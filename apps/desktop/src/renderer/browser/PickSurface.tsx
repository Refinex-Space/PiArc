// Picked elements in place (design addendum B3.1, B3.6): after a pick the page holds still (its
// view is hidden and the frame taken at the click shows instead), the element is outlined and
// a card opens beside it. The card lists every picked element; the open one shows its selector,
// component, source, a read-only information card (size, font, colors, spacing) and the box for
// what the user wants to say. "Add to conversation (N)" hands them all to the session's input;
// "Pick another", a click on the page or Esc lets the page move again and picking go on.
// Everything on the card from the page is data: text nodes, bidi controls revealed.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { ELEMENT_INFO, type BrowserImage } from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { CloseIcon, CopyGlyph, FileCodeCornerIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';
import { elementTitle, sourceText } from './context-items.js';
import { placeBeside, scaleRect, type Placement, type Rect } from './inline-place.js';
import type { TrayCard } from './picks.js';

const INFO_LABELS: Readonly<Record<(typeof ELEMENT_INFO)[number], MessageId>> = {
  display: 'browser.picks.info.display',
  'font-family': 'browser.picks.info.fontFamily',
  'font-size': 'browser.picks.info.fontSize',
  'font-weight': 'browser.picks.info.fontWeight',
  'line-height': 'browser.picks.info.lineHeight',
  color: 'browser.picks.info.color',
  'background-color': 'browser.picks.info.background',
  margin: 'browser.picks.info.margin',
  padding: 'browser.picks.info.padding',
  'border-radius': 'browser.picks.info.radius',
};

/** A computed color the swatch may paint: only `rgb()`/`rgba()` and hex, never a page string. */
const SWATCH = /^(?:rgba?\(\s*[\d.]+%?(?:\s*[,/ ]\s*[\d.]+%?){2,3}\s*\)|#[0-9a-f]{3,8})$/iu;

/** What the stage shows: the frozen page, and the element outlined when its box is known. */
export interface PickStage {
  readonly frame: BrowserImage;
  /** The card that is open. */
  readonly focus: string;
  /** The open card's element on this frame: its box in CSS pixels and image pixels per CSS px. */
  readonly outline?: { readonly id: string; readonly box: Rect; readonly scale: number };
}

export function PickSurface({
  stage,
  cards,
  onFocus,
  onComment,
  onRemove,
  onClear,
  onContinue,
  onHide,
  onAdd,
  onOpenSource,
  onCopySelector,
}: {
  readonly stage: PickStage;
  readonly cards: readonly TrayCard[];
  readonly onFocus: (id: string) => void;
  readonly onComment: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  /** Back to the live page, picking on. */
  readonly onContinue: () => void;
  /** Back to the live page; the cards wait. */
  readonly onHide: () => void;
  readonly onAdd: () => void;
  readonly onOpenSource: (card: TrayCard) => void;
  readonly onCopySelector: (card: TrayCard) => void;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const card = useRef<HTMLElement>(null);
  const [shown, setShown] = useState<{ ratio: number; outline?: Rect }>();
  const [place, setPlace] = useState<Placement>();

  // The outline follows the shown size of the frame; the card goes beside it.
  useLayoutEffect(() => {
    const stageElement = root.current;
    const imageElement = image.current;
    const cardElement = card.current;
    if (stageElement === null || imageElement === null || cardElement === null) return;
    const measure = () => {
      const ratio =
        stage.frame.width > 0 ? imageElement.getBoundingClientRect().width / stage.frame.width : 1;
      const outline =
        stage.outline?.id === stage.focus
          ? scaleRect(stage.outline.box, stage.outline.scale * ratio)
          : undefined;
      const size = { width: stageElement.clientWidth, height: stageElement.clientHeight };
      const own = { width: cardElement.offsetWidth, height: cardElement.offsetHeight };
      setShown(outline === undefined ? { ratio } : { ratio, outline });
      setPlace(
        outline === undefined
          ? {
              x: Math.max(12, (size.width - own.width) / 2),
              y: Math.max(12, size.height - own.height - 12),
              side: 'inside',
            }
          : placeBeside(outline, own, size),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stageElement);
    observer.observe(cardElement);
    return () => {
      observer.disconnect();
    };
  }, [stage, cards.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent) || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onContinue();
    }
  };

  const focused = cards.find((each) => each.pick.id === stage.focus);
  return (
    <div
      ref={root}
      className="browser-pickstage"
      data-testid="browser-pick-stage"
      onKeyDown={onKeyDown}
    >
      {/* The frozen page: a click on it goes back to the live page (Esc does too). */}
      <button
        type="button"
        className="browser-pickstage-back"
        tabIndex={-1}
        aria-label={t('browser.picks.continue')}
        data-testid="browser-pick-frame"
        onClick={onContinue}
      >
        <img ref={image} className="browser-pickstage-frame" src={stage.frame.data} alt="" />
      </button>
      {shown?.outline !== undefined && (
        <div
          className="browser-pickstage-outline"
          data-testid="browser-pick-outline"
          aria-hidden="true"
          style={{
            left: shown.outline.x,
            top: shown.outline.y,
            width: shown.outline.width,
            height: shown.outline.height,
          }}
        />
      )}
      <section
        ref={card}
        id="browser-picks"
        className="browser-pickcard"
        data-testid="browser-picks"
        data-side={place?.side}
        role="dialog"
        aria-label={t('browser.picks.title')}
        style={place === undefined ? { opacity: 0 } : { left: place.x, top: place.y }}
      >
        <div className="browser-pickcard-head">
          <span className="browser-pickcard-title">{t('browser.picks.title')}</span>
          {cards.length > 1 && (
            <Button
              variant="ghost"
              size="small"
              data-testid="browser-picks-clear"
              onClick={onClear}
            >
              {t('browser.picks.clear')}
            </Button>
          )}
          <IconButton
            size="xs"
            label={t('browser.picks.hide')}
            data-testid="browser-picks-hide"
            onClick={onHide}
          >
            <CloseIcon size={12} />
          </IconButton>
        </div>
        <ol className="browser-pickcard-list">
          {cards.map((each, index) => (
            <PickRow
              key={each.pick.id}
              n={index + 1}
              card={each}
              open={each === focused}
              onFocus={onFocus}
              onComment={onComment}
              onRemove={onRemove}
              onAdd={onAdd}
              onOpenSource={onOpenSource}
              onCopySelector={onCopySelector}
            />
          ))}
        </ol>
        <div className="browser-pickcard-actions">
          <Button size="small" data-testid="browser-picks-continue" onClick={onContinue}>
            {t('browser.picks.continue')}
          </Button>
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
      </section>
    </div>
  );
}

function PickRow({
  n,
  card,
  open,
  onFocus,
  onComment,
  onRemove,
  onAdd,
  onOpenSource,
  onCopySelector,
}: {
  readonly n: number;
  readonly card: TrayCard;
  readonly open: boolean;
  readonly onFocus: (id: string) => void;
  readonly onComment: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onAdd: () => void;
  readonly onOpenSource: (card: TrayCard) => void;
  readonly onCopySelector: (card: TrayCard) => void;
}) {
  const t = useT();
  const { context, id } = card.pick;
  const title = revealBidi(elementTitle(context));
  const commentId = `browser-pick-comment-${id}`;
  const box = useRef<HTMLTextAreaElement>(null);
  // An opened card has the box ready to type in.
  useEffect(() => {
    if (open) box.current?.focus({ preventScroll: true });
  }, [open]);
  return (
    <li
      className="browser-pick"
      data-testid="browser-pick-card"
      data-pick={id}
      data-open={open ? 'true' : 'false'}
    >
      <div className="browser-pick-line">
        <span className="browser-pick-number" aria-hidden="true">
          {n}
        </span>
        <button
          type="button"
          className="browser-pick-title"
          aria-expanded={open}
          data-testid="browser-pick-open"
          onClick={() => {
            onFocus(id);
          }}
        >
          <span className="visually-hidden">{t('browser.picks.number', { n })} </span>
          {title}
        </button>
        {!open && card.comment !== '' && (
          <span className="browser-pick-said" data-testid="browser-pick-said">
            {card.comment}
          </span>
        )}
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
      {open && (
        <div className="browser-pick-body">
          <div className="browser-pick-where">
            {card.pick.image !== undefined && (
              <img
                className="browser-pick-thumb"
                src={card.pick.image.data}
                alt=""
                width={card.pick.image.width}
                height={card.pick.image.height}
                data-testid="browser-pick-thumb"
              />
            )}
            <div className="browser-pick-names">
              <span className="browser-pick-selector-line">
                <code className="browser-pick-selector" data-testid="browser-pick-selector">
                  {revealBidi(context.selector)}
                </code>
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
              </span>
              {context.components.length > 0 && (
                <span className="browser-pick-component" data-testid="browser-pick-component">
                  {revealBidi(context.components.join(' ‹ '))}
                </span>
              )}
              <Source card={card} onOpenSource={onOpenSource} />
            </div>
          </div>
          <ElementInfo card={card} />
          <label className="visually-hidden" htmlFor={commentId}>
            {t('browser.picks.comment', { n })}
          </label>
          <textarea
            id={commentId}
            className="browser-pick-comment"
            data-testid="browser-pick-comment"
            rows={2}
            placeholder={t('browser.picks.askPlaceholder')}
            value={card.comment}
            ref={box}
            onChange={(event) => {
              onComment(id, event.target.value);
            }}
            onKeyDown={(event) => {
              if (isImeComposing(event.nativeEvent)) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onAdd();
              }
            }}
          />
        </div>
      )}
    </li>
  );
}

function Source({
  card,
  onOpenSource,
}: {
  readonly card: TrayCard;
  readonly onOpenSource: (card: TrayCard) => void;
}) {
  const t = useT();
  const source = sourceText(card.pick.context);
  if (source === undefined) return null;
  return (
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
  );
}

/** The read-only information card: size and the computed font, colors and spacing. */
function ElementInfo({ card }: { readonly card: TrayCard }) {
  const t = useT();
  const { box } = card.pick.context;
  const info = card.pick.info;
  const rows = ELEMENT_INFO.filter((name) => info[name] !== undefined);
  return (
    <dl className="browser-pick-info" data-testid="browser-pick-info">
      <div>
        <dt>{t('browser.picks.info.size')}</dt>
        <dd data-info="size">{`${String(box.width)} × ${String(box.height)}`}</dd>
      </div>
      {rows.map((name) => {
        const value = info[name] ?? '';
        return (
          <div key={name}>
            <dt>{t(INFO_LABELS[name])}</dt>
            <dd data-info={name}>
              {(name === 'color' || name === 'background-color') && SWATCH.test(value) && (
                <span
                  className="browser-pick-swatch"
                  aria-hidden="true"
                  style={{ background: value }}
                />
              )}
              <span>{revealBidi(value)}</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
