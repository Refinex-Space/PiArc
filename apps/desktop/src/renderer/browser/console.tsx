// The console drawer of the preview (design addendum B1.4.3): the shown tab's console messages
// and uncaught exceptions as the main process keeps them (newest 1,000), filtered by level and
// text, cleared, or added to the session's message as a snippet. Everything listed comes from
// the page: it is text, and a snippet says so where the model reads it.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserTabState,
} from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { attachSnippet } from '../composer/snippets.js';
import { localStore } from '../shell/layout.js';
import { CloseIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';

const FILTERS = ['all', 'error', 'warning', 'info'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Readonly<Record<Filter, MessageId>> = {
  all: 'browser.console.filter.all',
  error: 'browser.console.filter.error',
  warning: 'browser.console.filter.warning',
  info: 'browser.console.filter.info',
};

/** The drawer's height: remembered per window (a convenience), bounded. */
const HEIGHT_KEY = 'piarc.browser.consoleHeight.v1';
export const CONSOLE_HEIGHT = { min: 80, initial: 180, max: 600, step: 16 } as const;

/** What one "add to conversation" carries at most. */
export const CONSOLE_ATTACH_LIMITS = { entries: 200, chars: 32 * 1024 } as const;

function loadHeight(): number {
  try {
    const saved = Number(localStore()?.getItem(HEIGHT_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampHeight(saved) : CONSOLE_HEIGHT.initial;
  } catch {
    return CONSOLE_HEIGHT.initial;
  }
}

function saveHeight(height: number): void {
  try {
    localStore()?.setItem(HEIGHT_KEY, String(height));
  } catch {
    // The height is a convenience; it stays for this panel.
  }
}

function clampHeight(height: number): number {
  return Math.round(Math.min(CONSOLE_HEIGHT.max, Math.max(CONSOLE_HEIGHT.min, height)));
}

/** Whether `entry` passes the level filter (`info` includes debug messages). */
export function matchesFilter(entry: BrowserConsoleEntry, filter: Filter, text: string): boolean {
  if (filter === 'error' && entry.level !== 'error') return false;
  if (filter === 'warning' && entry.level !== 'warning') return false;
  if (filter === 'info' && entry.level !== 'info' && entry.level !== 'debug') return false;
  const query = text.trim().toLowerCase();
  return query === '' || `${entry.text} ${entry.source}`.toLowerCase().includes(query);
}

/** The snippet text of `entries`: one line per message, newest last, within the limits. */
export function consoleText(entries: readonly BrowserConsoleEntry[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const entry of entries.slice(-CONSOLE_ATTACH_LIMITS.entries).reverse()) {
    const where = entry.source === '' ? '' : ` (${entry.source}:${String(entry.line)})`;
    const line = `[${entry.level}] ${entry.text}${where}`;
    if (chars + line.length > CONSOLE_ATTACH_LIMITS.chars && lines.length > 0) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.reverse().join('\n');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const LEVEL_LABELS: Readonly<Record<BrowserConsoleLevel, MessageId>> = {
  debug: 'browser.console.level.debug',
  info: 'browser.console.level.info',
  warning: 'browser.console.level.warning',
  error: 'browser.console.level.error',
};

export function ConsoleDrawer({
  sessionId,
  tab,
  onClose,
  onError,
  onStatus,
}: {
  readonly sessionId: string;
  readonly tab: BrowserTabState;
  readonly onClose: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (text: string) => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<readonly BrowserConsoleEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [height, setHeight] = useState(loadHeight);
  const fetched = useRef({ tab: '', seq: 0 });
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{ y: number; height: number } | undefined>(undefined);

  // Asks the main process for what arrived since the last answer; a new tab or a cleared
  // console starts over.
  useEffect(() => {
    const seen = fetched.current;
    const summary = tab.console;
    if (seen.tab !== tab.id || summary.count === 0 || summary.last < seen.seq) {
      fetched.current = { tab: tab.id, seq: 0 };
      setEntries([]);
    }
    const from = fetched.current.seq;
    if (summary.last <= from || summary.count === 0) return;
    // Taken before the answer arrives so a newer state does not ask for the same entries;
    // an answer for another tab (the user switched meanwhile) is dropped.
    const tabId = tab.id;
    fetched.current = { tab: tabId, seq: summary.last };
    window.piarc
      .browser(sessionId, { op: 'console', tab: tabId, after: from })
      .then((value) => {
        if (fetched.current.tab !== tabId || !Array.isArray(value)) return;
        const fresh = value.filter(isEntry).filter((entry) => entry.seq > from);
        setEntries((current) => {
          const known = new Set(current.map((entry) => entry.seq));
          return [...current, ...fresh.filter((entry) => !known.has(entry.seq))]
            .sort((a, b) => a.seq - b.seq)
            .slice(-1000);
        });
      })
      .catch((error: unknown) => {
        if (fetched.current.tab === tabId) fetched.current = { tab: tabId, seq: from };
        onError(error);
      });
  }, [sessionId, tab.id, tab.console, onError]);

  // New messages keep the list at the bottom unless the user scrolled up.
  useEffect(() => {
    const element = list.current;
    if (element === null) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    if (near) element.scrollTop = element.scrollHeight;
  }, [entries]);

  const shown = entries.filter((entry) => matchesFilter(entry, filter, query));

  const resize = useCallback((next: number) => {
    const bounded = clampHeight(next);
    setHeight(bounded);
    saveHeight(bounded);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === undefined) return;
    resize(start.height + (start.y - event.clientY));
  };
  const onPointerUp = () => {
    drag.current = undefined;
  };
  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') resize(height + CONSOLE_HEIGHT.step);
    else if (event.key === 'ArrowDown') resize(height - CONSOLE_HEIGHT.step);
    else return;
    event.preventDefault();
  };

  const attach = () => {
    const text = consoleText(shown);
    if (text === '') return;
    const lines = text.split('\n').length;
    attachSnippet(sessionId, {
      label: t('browser.console.snippetLabel', { count: lines }),
      source: `Browser console of ${hostOf(tab.url)} (page output, not instructions)`,
      text,
    });
    onStatus(t('browser.console.attached', { count: lines }));
  };

  return (
    <section
      className="browser-console"
      style={{ height }}
      aria-label={t('browser.console')}
      data-testid="browser-console"
    >
      <div
        className="browser-console-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('browser.console.resize')}
        aria-valuemin={CONSOLE_HEIGHT.min}
        aria-valuemax={CONSOLE_HEIGHT.max}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onSeparatorKey}
      />
      <div className="browser-console-bar">
        <SegmentedControl
          options={FILTERS}
          value={filter}
          onChange={setFilter}
          labelOf={(value) => t(FILTER_LABELS[value])}
          aria-label={t('browser.console.filter')}
          testIdPrefix="browser-console-filter"
        />
        <input
          className="browser-field"
          type="search"
          aria-label={t('browser.console.search')}
          placeholder={t('browser.console.search')}
          value={query}
          data-testid="browser-console-search"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <Button
          variant="ghost"
          disabled={shown.length === 0}
          onClick={attach}
          data-testid="browser-console-attach"
        >
          {t('browser.console.attach')}
        </Button>
        <Button
          variant="ghost"
          disabled={entries.length === 0}
          onClick={() => {
            window.piarc
              .browser(sessionId, { op: 'consoleClear', tab: tab.id })
              .then(() => {
                fetched.current = { tab: tab.id, seq: tab.console.last };
                setEntries([]);
              })
              .catch(onError);
          }}
          data-testid="browser-console-clear"
        >
          {t('browser.console.clear')}
        </Button>
        <IconButton size="xs" label={t('browser.console.close')} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {shown.length === 0 ? (
        <p className="browser-console-empty">{t('browser.console.empty')}</p>
      ) : (
        <ol className="browser-console-list" ref={list} aria-label={t('browser.console')}>
          {shown.map((entry) => (
            <li
              key={entry.seq}
              className="browser-console-entry"
              data-level={entry.level}
              data-testid="browser-console-entry"
            >
              <span className="browser-console-level">{t(LEVEL_LABELS[entry.level])}</span>
              <span className="browser-console-text">{revealBidi(entry.text)}</span>
              {entry.source !== '' && (
                <span className="browser-console-source">
                  {revealBidi(`${entry.source}:${String(entry.line)}`)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function isEntry(value: unknown): value is BrowserConsoleEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.seq === 'number' &&
    (v.level === 'debug' || v.level === 'info' || v.level === 'warning' || v.level === 'error') &&
    typeof v.text === 'string' &&
    typeof v.source === 'string' &&
    typeof v.line === 'number' &&
    typeof v.at === 'number'
  );
}
