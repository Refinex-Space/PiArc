// The address bar's suggestions (design addendum B1.2.3): this workspace's history, the open
// tabs and the session's local services, ranked by the main process. Arrow keys choose, Enter
// opens, Mod+Enter opens in a new tab, Escape closes the list; nothing is asked while an input
// method composes (the address bar's key handler returns first, `isImeComposing`).
import { useCallback, useId, useRef, useState } from 'react';

import type { BrowserSuggestion } from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { revealBidi } from '../transcript/reveal.js';

const KIND: Record<BrowserSuggestion['kind'], MessageId> = {
  history: 'browser.suggest.history',
  tab: 'browser.suggest.tab',
  server: 'browser.suggest.server',
};

export type SuggestFetch = (input: string) => Promise<readonly BrowserSuggestion[]>;

/** The next selection when moving by `delta` through `count` items (−1 is none). */
export function nextSelection(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (delta === 1) return current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}

export interface Suggestions {
  readonly listId: string;
  readonly items: readonly BrowserSuggestion[];
  readonly selected: number;
  readonly open: boolean;
  /** Asks for the suggestions of `input`; a newer request replaces an older one. */
  request(input: string): void;
  close(): void;
  /** Moves the selection; false when no list is open. */
  move(delta: 1 | -1): boolean;
  /** The selected suggestion, if any. */
  chosen(): BrowserSuggestion | undefined;
  optionId(index: number): string;
}

export function useSuggestions(fetch: SuggestFetch | undefined): Suggestions {
  const listId = useId();
  const [items, setItems] = useState<readonly BrowserSuggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const [open, setOpen] = useState(false);
  const latest = useRef(0);
  const close = useCallback(() => {
    latest.current += 1;
    setOpen(false);
    setSelected(-1);
  }, []);
  const request = useCallback(
    (input: string) => {
      // An empty field shows the address, not a list.
      if (fetch === undefined || input.trim() === '') {
        close();
        return;
      }
      const asked = ++latest.current;
      fetch(input).then(
        (list) => {
          if (asked !== latest.current) return;
          setItems(list);
          setSelected(-1);
          setOpen(list.length > 0);
        },
        () => {
          // Suggestions are a convenience: the address still works without them.
        },
      );
    },
    [fetch, close],
  );
  return {
    listId,
    items,
    selected,
    open,
    request,
    close,
    move: (delta) => {
      if (!open || items.length === 0) return false;
      setSelected(nextSelection(selected, delta, items.length));
      return true;
    },
    chosen: () => (open ? items[selected] : undefined),
    optionId: (index) => `${listId}-${String(index)}`,
  };
}

export function SuggestionList({
  suggestions,
  onPick,
}: {
  readonly suggestions: Suggestions;
  /** A suggestion was clicked; `newTab` with the modifier key held. */
  readonly onPick: (suggestion: BrowserSuggestion, newTab: boolean) => void;
}) {
  const t = useT();
  if (!suggestions.open) return null;
  return (
    <ul
      id={suggestions.listId}
      className="browser-suggestions"
      role="listbox"
      aria-label={t('browser.suggest.label')}
      data-testid="browser-suggestions"
    >
      {suggestions.items.map((item, index) => (
        <li
          key={`${item.kind} ${item.url}`}
          id={suggestions.optionId(index)}
          role="option"
          aria-selected={index === suggestions.selected}
          className="browser-suggestion"
          data-testid="browser-suggestion"
          data-kind={item.kind}
          data-url={item.url}
          // Keep the focus in the address bar: it closes the list on blur.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            onPick(item, event.metaKey || event.ctrlKey);
          }}
        >
          <span className="browser-suggestion-title">
            {revealBidi(item.title === '' ? item.url : item.title)}
          </span>
          <span className="browser-suggestion-url">{revealBidi(item.url)}</span>
          <span className="browser-suggestion-kind">{t(KIND[item.kind])}</span>
        </li>
      ))}
    </ul>
  );
}
