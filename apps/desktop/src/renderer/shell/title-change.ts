// A session's title can change in place: a generated title replaces the first message
// (ADR-0106), or the user renames the session. The count is the key that replays the title's
// entrance; the first render shows the title as it is.
import { useRef } from 'react';

/** How many times `title` changed since this component first rendered it. */
export function useTitleChanges(title: string): number {
  const seen = useRef({ title, changes: 0 });
  // Comparing before writing keeps a repeated render (StrictMode) from counting twice.
  if (seen.current.title !== title) {
    seen.current = { title, changes: seen.current.changes + 1 };
  }
  return seen.current.changes;
}
