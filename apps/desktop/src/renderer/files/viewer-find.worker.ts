// Isolate user-entered regular expressions from typing, painting, and the session event loop.
import { findMatches, type FindOptions } from './viewer-model.js';
self.addEventListener(
  'message',
  (event: MessageEvent<{ lines: string[]; query: string; options: FindOptions }>) => {
    const { lines, query, options } = event.data;
    self.postMessage(findMatches(lines, query, options));
  },
);
