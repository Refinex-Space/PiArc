// Native web search (T38, ADR-0055): the provider's own search tool, run in one auxiliary
// request after `WebSearch` passed the `tool_call` gate. pi-ai 1.5.2 has no server-tool types:
// `onPayload` adds the provider's tool definition to the request and `onProviderStreamEvent`
// reads the result blocks the adapter itself skips. Each provider's wire format stays in this
// file; the tool only sees `WebSearchSource`s.
//
// Anthropic Messages (`web_search_20250305`): a `server_tool_use` block, then one
// `content_block_start` carrying the whole `web_search_tool_result` (a list of
// `web_search_result` with `url`, `title`, `encrypted_content`, `page_age`, or a
// `web_search_tool_result_error` with `error_code`); the answer's text blocks cite results with
// `web_search_result_location` citations (`citations_delta` while streaming).
import type { Api, Model } from '@earendil-works/pi-ai';
import type { CatalogModel, WebSearchSource } from '@piarc/protocol';

import { isObject } from '../runtime/items.js';

/** The domain filters of one search. */
export interface SearchFilters {
  readonly allowedDomains: readonly string[];
  readonly blockedDomains: readonly string[];
}

/** What a native search found. */
export interface NativeOutcome {
  readonly sources: WebSearchSource[];
  /** The provider's error code (`max_uses_exceeded`, `unavailable`, …). */
  readonly error?: string;
  /** Whether the provider ran the search at all. */
  readonly searched: boolean;
}

/** One native search's request hooks and what they collected. */
export interface NativeSearch {
  readonly onPayload: (payload: unknown) => unknown;
  readonly onEvent: (event: unknown) => void;
  outcome(): NativeOutcome;
}

/** Whether PiArc knows the native search of `model`'s provider: Anthropic's own models. */
export function nativeSearchKnown(model: Pick<Model<Api>, 'provider' | 'api'>): boolean {
  return model.api === 'anthropic-messages' && model.provider === 'anthropic';
}

/** The catalog's `nativeWebSearch` for `model`. */
export function nativeSearchCapability(
  model: Pick<Model<Api>, 'provider' | 'api'>,
): Pick<CatalogModel, 'nativeWebSearch'> {
  return nativeSearchKnown(model) ? { nativeWebSearch: true } : {};
}

/** Snippet characters kept from a citation. */
const SNIPPET_CHARS = 400;

function anthropicSearch(filters: SearchFilters): NativeSearch {
  const results: { title: string; url: string }[] = [];
  const cited = new Map<string, string>();
  let error: string | undefined;
  let searched = false;
  const tool: Record<string, unknown> = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 1,
    ...(filters.allowedDomains.length > 0 ? { allowed_domains: filters.allowedDomains } : {}),
    ...(filters.blockedDomains.length > 0 && filters.allowedDomains.length === 0
      ? { blocked_domains: filters.blockedDomains }
      : {}),
  };
  const cite = (citation: unknown): void => {
    if (!isObject(citation) || citation.type !== 'web_search_result_location') return;
    const { url, cited_text: text } = citation;
    if (typeof url === 'string' && typeof text === 'string' && !cited.has(url)) {
      cited.set(url, text.slice(0, SNIPPET_CHARS));
    }
  };
  return {
    onPayload: (payload) => (isObject(payload) ? { ...payload, tools: [tool] } : payload),
    onEvent: (event) => {
      if (!isObject(event)) return;
      if (event.type === 'content_block_start' && isObject(event.content_block)) {
        const block = event.content_block;
        if (block.type === 'server_tool_use') searched = true;
        if (block.type === 'web_search_tool_result') {
          searched = true;
          const content: unknown = block.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (isObject(item) && typeof item.url === 'string') {
                results.push({
                  url: item.url,
                  title:
                    typeof item.title === 'string' && item.title !== '' ? item.title : item.url,
                });
              }
            }
          } else if (isObject(content) && typeof content.error_code === 'string') {
            error = content.error_code;
          }
        }
        if (block.type === 'text' && Array.isArray(block.citations)) {
          for (const citation of block.citations as unknown[]) cite(citation);
        }
      }
      if (event.type === 'content_block_delta' && isObject(event.delta)) {
        if (event.delta.type === 'citations_delta') cite(event.delta.citation);
      }
    },
    outcome: () => ({
      sources: results.map((r) => {
        const snippet = cited.get(r.url);
        return { title: r.title, url: r.url, ...(snippet === undefined ? {} : { snippet }) };
      }),
      ...(error === undefined ? {} : { error }),
      searched,
    }),
  };
}

/** The native search of `model`, or undefined when its provider has none PiArc knows. */
export function nativeSearch(model: Model<Api>, filters: SearchFilters): NativeSearch | undefined {
  return model.api === 'anthropic-messages' ? anthropicSearch(filters) : undefined;
}
