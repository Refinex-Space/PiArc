// Pieces several rows share: the copy button, the attachment and mention chips, the clock for
// running timers, sizes and durations as text.
import type { InputMention } from '@piarc/protocol';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import type { AttachmentChip } from '../../store/transcript.js';
import { FileGlyph, ImageGlyph } from '../../shell/icons.js';
import { baseName } from './summary.js';

/** How long a copy button shows its confirmation (ms). */
const COPIED_FEEDBACK_MS = 1_500;

export function CopyButton({
  label,
  text,
  testId,
}: {
  readonly label: string;
  readonly text: () => string;
  readonly testId?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <button
      type="button"
      className="row-action"
      data-testid={testId}
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
      {copied ? t('transcript.copied') : label}
    </button>
  );
}

/** A byte count for people: `512 B`, `12 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** The current time, refreshed every `intervalMs` while `active`. */
/** One clock for every message time: it ticks once a minute while any time is shown. */
const minuteListeners = new Set<() => void>();
let minuteTimer: number | undefined;
let minuteNow = Date.now();

function subscribeMinute(listener: () => void): () => void {
  if (minuteTimer === undefined) {
    minuteNow = Date.now();
    minuteTimer = window.setInterval(() => {
      minuteNow = Date.now();
      for (const each of [...minuteListeners]) each();
    }, 60_000);
  }
  minuteListeners.add(listener);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== undefined) {
      window.clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}

/** When a message was sent or answered (ADR-0080): relative, the full time as its tooltip. */
export function MessageTime({ at }: { readonly at: number }) {
  const { format } = useApp();
  const now = useSyncExternalStore(subscribeMinute, () => minuteNow);
  const full = format.dateTime(at);
  return (
    <time
      className="row-time"
      dateTime={new Date(at).toISOString()}
      data-tooltip={full}
      aria-label={full}
      data-testid="message-time"
    >
      {format.relative(at, Math.max(now, at))}
    </time>
  );
}

export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs, active]);
  return now;
}

/** `elapsed` milliseconds as `12 s` or `3 min 4 s`. */
export function useElapsedText(): (elapsedMs: number) => string {
  const t = useT();
  return (elapsedMs) => {
    const total = Math.max(0, Math.floor(elapsedMs / 1000));
    return t('transcript.elapsed', { minutes: Math.floor(total / 60), seconds: total % 60 });
  };
}

export function AttachmentChips({
  attachments,
}: {
  readonly attachments: readonly AttachmentChip[];
}) {
  const t = useT();
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="attachment-chips" data-testid="attachment-chips">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.name}-${String(index)}`}
          className={`attachment-chip is-${attachment.kind}`}
          data-testid="attachment-chip"
          data-kind={attachment.kind}
        >
          <span className="attachment-chip-icon" aria-hidden="true">
            {attachment.kind === 'pdf' ? <FileGlyph size={20} /> : <ImageGlyph size={20} />}
          </span>
          <span className="attachment-chip-text" aria-hidden="true">
            <span className="attachment-chip-name">{attachment.name}</span>
            <span className="attachment-chip-size">
              {attachment.kind === 'pdf'
                ? t('transcript.attachment.pages', { pages: attachment.pageCount ?? 0 })
                : formatSize(attachment.size)}
            </span>
          </span>
          <span className="visually-hidden">
            {attachment.kind === 'pdf'
              ? t('transcript.attachment.pdf', {
                  name: attachment.name,
                  pages: attachment.pageCount ?? 0,
                })
              : t('transcript.attachment.image', {
                  name: attachment.name,
                  size: formatSize(attachment.size),
                })}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The user's text with each mention shown as a chip (`@name`, the path in its title): the
 * chip's data is the mention, its look the file's name, and the text the model read keeps the
 * whole `@path` (architecture section 8.2).
 */
export function MentionText({
  text,
  mentions,
  onOpen,
}: {
  readonly onOpen?: ((path: string) => void) | undefined;
  readonly text: string;
  readonly mentions: readonly InputMention[];
}) {
  const t = useT();
  const parts: ReactNode[] = [];
  let at = 0;
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  for (const [index, mention] of sorted.entries()) {
    if (mention.start < at || mention.end > text.length) {
      continue;
    }
    if (mention.start > at) {
      parts.push(text.slice(at, mention.start));
    }
    parts.push(
      onOpen ? (
        <button
          type="button"
          key={index}
          data-testid="mention-chip"
          className="mention-chip file-path-action"
          data-path={mention.path}
          title={mention.path}
          onClick={() => {
            onOpen(mention.path);
          }}
        >
          @{baseName(mention.path)}
        </button>
      ) : (
        <span
          key={`m${String(index)}`}
          className="mention-chip"
          data-testid="mention-chip"
          data-path={mention.path}
          title={t('transcript.mention', { path: mention.path })}
        >
          @{baseName(mention.path)}
        </span>
      ),
    );
    at = mention.end;
  }
  if (at < text.length) {
    parts.push(text.slice(at));
  }
  return <>{parts}</>;
}
