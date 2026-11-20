// `WebFetch` (architecture section 6.1.4, T29, ADR-0045): Core fetches the URL for the approved
// call (`web/fetch`: address checks, same-site redirects, limits, HTML to Markdown), then the
// auxiliary model answers the call's `prompt` from the page. The answer is the tool result: page
// text never reaches the system prompt, and nothing on the page changes a permission decision
// (architecture section 10.1). A redirect to another host comes back as the new URL, which the
// model may fetch with a new call (a new permission decision).
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import type { CoreIo } from '../tools/core-io.js';
import type { AuxiliaryModel } from './auxiliary.js';
import { crossHostRedirect, extractionPrompt, EXTRACT_SYSTEM } from './prompts/web-fetch.js';

const fetchSchema = Type.Object({
  url: Type.String({ minLength: 1, description: 'The complete http or https URL to fetch.' }),
  prompt: Type.String({
    minLength: 1,
    description: 'What to find out from the page.',
  }),
});

/** What the transcript shows about a fetch (the item's `details.webFetch`). */
export interface WebFetchDetails {
  readonly url: string;
  readonly finalUrl?: string;
  readonly status?: number;
  readonly redirect?: string;
  readonly bytes?: number;
  readonly truncated?: boolean;
  readonly model?: string;
}

export function createWebFetchTool(
  presentation: ToolPresentation,
  io: CoreIo,
  auxiliary: AuxiliaryModel,
): ToolDefinition {
  return defineTool<typeof fetchSchema, { webFetch: WebFetchDetails }>({
    ...presentationOf(presentation),
    parameters: fetchSchema,
    async execute(toolCallId, params, signal) {
      const abort = signal ?? new AbortController().signal;
      const page = await io.webFetch(params.url, { tool: 'WebFetch', toolCallId }, abort);
      if (page.redirect != null) {
        return {
          content: [
            {
              type: 'text',
              text: crossHostRedirect(page.url, page.redirect.url, page.redirect.status),
            },
          ],
          details: {
            webFetch: { url: params.url, status: page.status, redirect: page.redirect.url },
          },
        };
      }
      const truncated = page.contentTruncated || page.bodyTruncated;
      const answer = await auxiliary.complete({
        purpose: 'webFetch',
        system: EXTRACT_SYSTEM,
        prompt: extractionPrompt(page.url, params.prompt, page.content, truncated),
        signal: abort,
      });
      const status = page.status >= 400 ? `HTTP ${String(page.status)}. ` : '';
      return {
        content: [{ type: 'text', text: `${status}${answer.text}` }],
        details: {
          webFetch: {
            url: params.url,
            finalUrl: page.url,
            status: page.status,
            bytes: page.bytes,
            truncated,
            model: `${answer.model.provider}/${answer.model.id}`,
          },
        },
      };
    },
  });
}
