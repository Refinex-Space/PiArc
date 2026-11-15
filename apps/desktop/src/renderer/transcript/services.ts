// The transcript's collaborators, created once per page and shared through React context.
import { createContext, useContext, useSyncExternalStore } from 'react';

import { HighlightClient } from './highlight/highlight-client.js';
import { TranscriptStore } from './item-store.js';
import { MarkdownClient, type ParsedDoc } from './markdown/markdown-client.js';
import { RowHeights } from './row-heights.js';
import { StreamingDriver } from './streaming-driver.js';

/** Counts commits per row; the prototype page uses it to show what re-rendered. */
export interface RenderCounter {
  note(id: string): void;
}

export interface TranscriptServices {
  readonly store: TranscriptStore;
  readonly markdown: MarkdownClient;
  readonly highlight: HighlightClient;
  readonly driver: StreamingDriver;
  readonly heights: RowHeights;
  readonly renderCounter: RenderCounter | null;
}

/** Starts the two workers and wires the store, the clients and the streaming driver. */
export function createTranscriptServices(renderCounter: RenderCounter | null): TranscriptServices {
  const markdownWorker = new Worker(new URL('../workers/markdown.worker.ts', import.meta.url), {
    type: 'module',
    name: 'piarc-markdown',
  });
  const highlightWorker = new Worker(new URL('../workers/highlight.worker.ts', import.meta.url), {
    type: 'module',
    name: 'piarc-highlight',
  });
  const store = new TranscriptStore();
  const markdown = new MarkdownClient(markdownWorker);
  return {
    store,
    markdown,
    highlight: new HighlightClient(highlightWorker),
    driver: new StreamingDriver(store, markdown, window),
    heights: new RowHeights(),
    renderCounter,
  };
}

export const TranscriptContext = createContext<TranscriptServices | null>(null);

export function useTranscriptServices(): TranscriptServices {
  const services = useContext(TranscriptContext);
  if (services === null) {
    throw new Error('Transcript components need a TranscriptContext provider');
  }
  return services;
}

/** The parsed blocks of one item, re-rendering only when that item's blocks change. */
export function useParsedDoc(id: string): ParsedDoc | undefined {
  const { markdown } = useTranscriptServices();
  return useSyncExternalStore(
    (listener) => markdown.subscribe(id, listener),
    () => markdown.get(id),
  );
}
