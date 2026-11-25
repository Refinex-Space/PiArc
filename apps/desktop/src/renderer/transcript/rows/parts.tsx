// Parts the session pane's rows share (ADR-0078): the step row (a tool call, a group of them,
// thinking, a status line), the +/− pill and the icon copy button. Styles in session.css.
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { CheckGlyph, CopyGlyph, StepCaret } from '../../shell/icons.js';

/** How long a copy button shows its check mark (ms). */
export const COPIED_MS = 1_200;

/** What a step row shows about its call or line. */
export type StepState = 'done' | 'busy' | 'blocked' | 'failed' | 'stopped' | 'denied';

export interface StepRowProps {
  /** The verb ("Read", "Ran"), in the secondary ink. */
  readonly verb: ReactNode;
  /** The object ("index.html", the command), in the primary ink. */
  readonly meta?: ReactNode | undefined;
  /** The full object, shown as the tooltip when the line cuts it. */
  readonly metaTitle?: string | undefined;
  readonly state: StepState;
  /** The outcome word after the object ("Failed", "Needs approval"). */
  readonly outcome?: ReactNode | undefined;
  /** Pills, counts and durations after the text. */
  readonly trail?: ReactNode | undefined;
  /** Defined: the line is a disclosure button. */
  readonly expanded?: boolean | undefined;
  readonly onToggle?: (() => void) | undefined;
  /** The disclosure cannot be used right now (it stays open while the model thinks). */
  readonly toggleDisabled?: boolean | undefined;
  /** Controls after the line (not inside its button): open a file, a settings link. */
  readonly aside?: ReactNode | undefined;
  /** Lines under the head that stay visible whether the step is open or not. */
  readonly notes?: ReactNode | undefined;
  readonly testId?: string | undefined;
  readonly lineTestId?: string | undefined;
  readonly textTestId?: string | undefined;
  readonly children?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/**
 * One step: verb, object, outcome and trail on a single line, the caret at the end when it
 * opens a body. A running step's text shimmers; the whole line is the click target.
 */
export function StepRow({
  verb,
  meta,
  metaTitle,
  state,
  outcome,
  trail,
  expanded,
  onToggle,
  toggleDisabled,
  aside,
  notes,
  testId,
  lineTestId,
  textTestId,
  children,
  className,
}: StepRowProps) {
  const text = (
    <>
      <span className={`step-text${state === 'busy' ? ' shimmer' : ''}`} data-testid={textTestId}>
        <span className="step-verb">{verb}</span>
        {meta === undefined ? null : (
          <span className="step-meta" title={metaTitle}>
            {meta}
          </span>
        )}
      </span>
      {outcome === undefined ? null : <span className="step-outcome">{outcome}</span>}
      {trail === undefined ? null : <span className="step-trail">{trail}</span>}
    </>
  );
  return (
    <div
      className={`step${className === undefined ? '' : ` ${className}`}`}
      data-state={state}
      data-testid={testId}
    >
      <div className="step-head">
        {expanded === undefined ? (
          <div className="step-line" data-testid={lineTestId}>
            {text}
          </div>
        ) : (
          <button
            type="button"
            className="step-line"
            aria-expanded={expanded}
            aria-disabled={toggleDisabled}
            data-testid={lineTestId}
            onClick={onToggle}
          >
            {text}
            <span className="step-caret" aria-hidden="true">
              <StepCaret />
            </span>
          </button>
        )}
        {aside === undefined ? null : <span className="step-aside">{aside}</span>}
      </div>
      {notes === undefined ? null : <div className="step-notes">{notes}</div>}
      {expanded === true && children !== undefined ? (
        <div className="step-body">{children}</div>
      ) : null}
    </div>
  );
}

/** Segments after a step's text, separated by middle dots. */
export function Segments({ children }: { readonly children: readonly ReactNode[] }) {
  const shown = children.filter(
    (child) => child !== null && child !== undefined && child !== false,
  );
  return shown.map((child, index) => (
    <Fragment key={index}>
      {index > 0 ? (
        <span className="step-dot" aria-hidden="true">
          ·
        </span>
      ) : null}
      {child}
    </Fragment>
  ));
}

/** Lines added and removed as a green and a red segment; nothing when both are zero. */
export function DiffPill({
  added,
  removed,
  testId,
}: {
  readonly added: number;
  readonly removed: number;
  readonly testId?: string;
}) {
  const t = useT();
  if (added === 0 && removed === 0) return null;
  return (
    <span
      className="diff-pill"
      data-testid={testId}
      role="img"
      aria-label={t('transcript.diffCounts', { added, removed })}
    >
      <span className="diff-added">+{added}</span> <span className="diff-removed">−{removed}</span>
    </span>
  );
}

/** An icon button that copies `text()` and shows a check mark for a moment. */
export function CopyIconButton({
  label,
  text,
  testId,
  size = 'xs',
  glyph,
}: {
  readonly label: string;
  readonly text: () => string;
  readonly testId?: string;
  readonly size?: 'xs' | 'sm';
  /** The icon before copying (the copy glyph by default). */
  readonly glyph?: ReactNode;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <IconButton
      label={copied ? t('transcript.copied') : label}
      size={size}
      data-testid={testId}
      data-copied={copied}
      onMouseDown={(event) => {
        // Keep the focus (and a selection) where it was.
        event.preventDefault();
      }}
      onClick={() => {
        navigator.clipboard.writeText(text()).then(
          () => {
            setCopied(true);
          },
          (error: unknown) => {
            console.error('[transcript] copying failed', error);
          },
        );
      }}
    >
      {copied ? <CheckGlyph /> : (glyph ?? <CopyGlyph />)}
    </IconButton>
  );
}
