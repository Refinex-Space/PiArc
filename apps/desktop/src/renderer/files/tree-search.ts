import { useEffect, useState } from 'react';
import { cancelProjectSearch, searchProjectFiles, type ProjectMatch } from './api.js';
import { reason } from '../shell/errors.js';

export interface SearchOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regexp: boolean;
}

export const DEFAULT_SEARCH: SearchOptions = { matchCase: false, wholeWord: false, regexp: false };

interface SearchResult {
  readonly results: readonly ProjectMatch[];
  readonly truncated: boolean;
  readonly phase: 'waiting' | 'ready' | 'error';
  readonly error?: string;
}

const WAITING: SearchResult = { results: [], truncated: false, phase: 'waiting' };
const EMPTY: SearchResult = { results: [], truncated: false, phase: 'ready' };

/** Cancel in Core as well as in React. A previous, slower query must not be selectable as the
 * answer to the new input, including the debounce interval before its Core call starts. */
export function useProjectSearch(
  sessionId: string,
  query: string,
  options: SearchOptions,
  revision: number,
) {
  const text = query.trim();
  const content = text.startsWith('?');
  const needle = content ? text.slice(1).trim() : text;
  const [response, setResponse] = useState<{ key: string; result: SearchResult }>();
  const key = JSON.stringify([sessionId, text, options, revision]);
  useEffect(() => {
    if (!needle) return;
    const searchId = 'files-' + crypto.randomUUID();
    let live = true;
    let started = false;
    let completed = false;
    const timer = setTimeout(() => {
      started = true;
      void searchProjectFiles(sessionId, {
        query: needle,
        mode: content ? 'content' : 'name',
        searchId,
        ...options,
      }).then(
        (result) => {
          completed = true;
          if (live) setResponse({ key, result: { ...result, phase: 'ready' } });
        },
        (error: unknown) => {
          completed = true;
          if (live)
            setResponse({
              key,
              result: {
                ...EMPTY,
                phase: 'error',
                error: reason(error),
              },
            });
        },
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
      if (started && !completed)
        void cancelProjectSearch(sessionId, searchId).catch((error: unknown) => {
          console.warn('[files] could not cancel project search', error);
        });
    };
  }, [key, needle, content, options, sessionId]);
  return {
    content,
    needle,
    ...(!needle ? EMPTY : response?.key === key ? response.result : WAITING),
  };
}
