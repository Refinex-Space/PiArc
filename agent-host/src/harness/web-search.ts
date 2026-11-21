// `WebSearch` (architecture section 6.1.4, T38, ADR-0055). The model calls PiArc's tool; once
// the `tool_call` gate allowed it (Manual asks, `WebSearch` rules and PreToolUse hooks apply to
// every backend alike) the search runs on:
//
// - the provider's own search when the session's model has one (`nativeWebSearch`): one
//   auxiliary request to the same provider with only its search tool (`providers/web-search.ts`
//   adds it and reads the result blocks); never added to the session's own requests, which
//   would let the provider search outside the gate;
// - otherwise the user's third-party service through Core (`web/search`, which consumes the same
//   approval and keeps the API key);
// - otherwise the result says why there is none.
//
// The session gets the tool only when one of the two was usable when it opened (the tool set
// stays the same for the whole session); which one runs is decided per call.
import {
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { WebSearchSource } from '@piarc/protocol';
import { Type } from 'typebox';

import { nativeSearch, type SearchFilters } from '../providers/web-search.js';
import { presentationOf } from '../tools/presentation.js';
import type { CoreIo } from '../tools/core-io.js';
import type { ToolPresentation } from '../tools/profile.js';
import type { AuxiliaryModel } from './auxiliary.js';
import {
  NATIVE_SEARCH_SYSTEM,
  NO_SEARCH_BACKEND,
  nativeSearchFailed,
  nativeSearchPrompt,
  searchResultText,
} from './prompts/web-search.js';

const searchSchema = Type.Object({
  query: Type.String({ minLength: 2, description: 'The search query.' }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Only return results from these domains (and their subdomains).',
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Never return results from these domains (and their subdomains).',
    }),
  ),
});

/** What the transcript shows about a search (the item's `details.webSearch`). */
export interface WebSearchDetails {
  readonly query: string;
  /** `native` or the third-party backend's id. */
  readonly backend: string;
  readonly sources: readonly WebSearchSource[];
}

/** What the tool needs of its session. */
export interface WebSearchHost {
  readonly io: CoreIo;
  readonly auxiliary: AuxiliaryModel;
  readonly session: () => AgentSession | undefined;
  /** Whether `model` searches natively (the catalog and the user's per-model setting). */
  readonly native: (model: Model<Api>) => boolean;
}

/** The host's domain lists of a call. */
function filtersOf(params: {
  allowed_domains?: string[] | undefined;
  blocked_domains?: string[] | undefined;
}): SearchFilters {
  const clean = (list: readonly string[] | undefined) =>
    (list ?? []).map((d) => d.trim()).filter((d) => d !== '');
  return {
    allowedDomains: clean(params.allowed_domains),
    blockedDomains: clean(params.blocked_domains),
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function onDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  return d !== '' && (host === d || host.endsWith(`.${d}`));
}

/** The provider applies the filters, but only one of the two lists at a time: apply both. */
function filtered(sources: readonly WebSearchSource[], filters: SearchFilters): WebSearchSource[] {
  return sources.filter((s) => {
    const host = hostOf(s.url);
    if (host === undefined) return false;
    const allowed =
      filters.allowedDomains.length === 0 || filters.allowedDomains.some((d) => onDomain(host, d));
    return allowed && !filters.blockedDomains.some((d) => onDomain(host, d));
  });
}

async function searchNatively(
  host: WebSearchHost,
  model: Model<Api>,
  query: string,
  filters: SearchFilters,
  signal: AbortSignal,
): Promise<{ sources: WebSearchSource[]; notes: string }> {
  const search = nativeSearch(model, filters);
  if (search === undefined) throw new Error(nativeSearchFailed('unsupported provider'));
  const answer = await host.auxiliary.complete({
    purpose: 'webSearch',
    system: NATIVE_SEARCH_SYSTEM,
    prompt: nativeSearchPrompt(query),
    signal,
    model,
    onPayload: search.onPayload,
    onProviderStreamEvent: search.onEvent,
  });
  const outcome = search.outcome();
  if (outcome.error !== undefined) throw new Error(nativeSearchFailed(outcome.error));
  if (!outcome.searched) throw new Error(nativeSearchFailed('the model did not search'));
  return { sources: filtered(outcome.sources, filters), notes: answer.text };
}

export function createWebSearchTool(
  presentation: ToolPresentation,
  host: WebSearchHost,
): ToolDefinition {
  return defineTool<typeof searchSchema, { webSearch: WebSearchDetails }>({
    ...presentationOf(presentation),
    parameters: searchSchema,
    async execute(toolCallId, params, signal) {
      const abort = signal ?? new AbortController().signal;
      const filters = filtersOf(params);
      const model: Model<Api> | undefined = host.session()?.model;
      if (model !== undefined && host.native(model)) {
        const { sources, notes } = await searchNatively(host, model, params.query, filters, abort);
        return {
          content: [
            { type: 'text', text: searchResultText(params.query, model.name, sources, notes) },
          ],
          details: { webSearch: { query: params.query, backend: 'native', sources } },
        };
      }
      const available = await host.io.searchBackend(abort);
      if (available.backend == null) throw new Error(NO_SEARCH_BACKEND);
      const found = await host.io.webSearch(
        params.query,
        filters,
        { tool: 'WebSearch', toolCallId },
        abort,
      );
      return {
        content: [
          {
            type: 'text',
            text: searchResultText(params.query, available.backend.name, found.results),
          },
        ],
        details: {
          webSearch: { query: params.query, backend: found.backend, sources: found.results },
        },
      };
    },
  });
}
