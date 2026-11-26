// `Browser` (ADR-0089, design addendum `docs/architecture/addenda/browser.md` B2.1): the model
// writes a script against the browser SDK; Core checks the approved call (`browser/run`) and
// hands the script to the desktop app, which runs it in an isolated script host against the
// session's TaskSpaces. The result is what the script printed, inside a boundary with a fresh
// nonce (page text cannot close it), followed by PiArc's notes and the attached screenshots.
// Page content never reaches the system prompt and changes no permission (architecture
// section 10.1).
import { randomBytes } from 'node:crypto';

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BrowserItemImage, BrowserRunResult } from '@piarc/protocol';
import { Type } from 'typebox';

import { AhpError } from '../protocol/errors.js';
import type { CoreIo } from '../tools/core-io.js';
import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import {
  blockedNote,
  browserStateText,
  BROWSER_UNAVAILABLE,
  type StateSpaceText,
  imagesNote,
  scriptError,
  truncatedNote,
} from './prompts/browser.js';

/** The run time a call may ask for, in milliseconds (Core clamps to the same range). */
export const BROWSER_TIMEOUT = { min: 1_000, default: 120_000, max: 600_000 } as const;

const browserSchema = Type.Object({
  script: Type.String({
    minLength: 1,
    description: 'The JavaScript to run (an async function body with the browser helpers).',
  }),
  description: Type.Optional(
    Type.String({ description: 'A short label for the user, such as "Check the login form".' }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: BROWSER_TIMEOUT.min,
      maximum: BROWSER_TIMEOUT.max,
      description: 'How long the script may run, in milliseconds (default 120000).',
    }),
  ),
});

/** What the transcript shows about a run (the item's `details.browser`). */
export interface BrowserDetails {
  readonly description?: string;
  readonly outcome: 'ok' | 'error' | 'unavailable';
  readonly images: number;
  /** The screenshots Core kept in the session's blobs (ADR-0093). */
  readonly shots?: readonly BrowserItemImage[];
  readonly truncated?: boolean;
  readonly spill?: string;
  readonly blockedHosts?: readonly string[];
  readonly errorCode?: string;
}

type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/**
 * The text of a `browserState` reminder (B2.7.3) from Core's JSON summary, or undefined when it
 * is not one. Page titles and addresses go inside a boundary named with `nonce`.
 */
export function browserStateNotice(json: string, nonce: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { spaces, userTabs } = value as { spaces?: unknown; userTabs?: unknown };
  if (!Array.isArray(spaces) || typeof userTabs !== 'number') return undefined;
  const parsed: StateSpaceText[] = [];
  for (const space of spaces as unknown[]) {
    const read = stateSpace(space);
    if (read === undefined) return undefined;
    parsed.push(read);
  }
  return browserStateText(parsed, userTabs, nonce);
}

function stateSpace(value: unknown): StateSpaceText | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const space = value as Record<string, unknown>;
  if (
    typeof space.id !== 'number' ||
    typeof space.name !== 'string' ||
    (space.controlledBy !== 'agent' && space.controlledBy !== 'user') ||
    typeof space.tabCount !== 'number'
  ) {
    return undefined;
  }
  const tabs: { title: string; url: string }[] = [];
  for (const tab of Array.isArray(space.tabs) ? (space.tabs as unknown[]) : []) {
    if (typeof tab !== 'object' || tab === null) return undefined;
    const { title, url } = tab as { title?: unknown; url?: unknown };
    if (typeof title !== 'string' || typeof url !== 'string') return undefined;
    tabs.push({ title, url });
  }
  return {
    id: space.id,
    name: space.name,
    mine: space.controlledBy === 'agent',
    tabs,
    tabCount: space.tabCount,
  };
}

/** The model's view of a run: output in a nonce boundary, notes, then the images. */
export function browserContent(result: BrowserRunResult, nonce: string): Block[] {
  const tag = `browser-output-${nonce}`;
  const lines = [`<${tag}>`, result.output, `</${tag}>`];
  const images = result.images ?? [];
  if (result.truncated === true) lines.push(truncatedNote(result.spill ?? undefined));
  if (result.blockedHosts != null && result.blockedHosts.length > 0) {
    lines.push(blockedNote(result.blockedHosts));
  }
  if (images.length > 0) lines.push(imagesNote(images.length));
  if (result.error != null) {
    lines.push(
      scriptError(result.error.name, result.error.message, result.error.code ?? undefined),
    );
  }
  return [
    { type: 'text', text: lines.join('\n') },
    ...images.map((image) => ({
      type: 'image' as const,
      data: image.data,
      mimeType: image.mediaType,
    })),
  ];
}

function detailsOf(result: BrowserRunResult, description: string | undefined): BrowserDetails {
  const shots = (result.images ?? []).flatMap((image) =>
    image.blob == null
      ? []
      : [
          {
            blob: image.blob,
            mediaType: image.mediaType,
            width: image.width,
            height: image.height,
          },
        ],
  );
  return {
    ...(description === undefined ? {} : { description }),
    outcome: result.error == null ? 'ok' : 'error',
    images: result.images?.length ?? 0,
    ...(shots.length === 0 ? {} : { shots }),
    ...(result.truncated === true ? { truncated: true } : {}),
    ...(result.spill == null ? {} : { spill: result.spill }),
    ...(result.blockedHosts == null || result.blockedHosts.length === 0
      ? {}
      : { blockedHosts: result.blockedHosts }),
    ...(result.error?.code == null ? {} : { errorCode: result.error.code }),
  };
}

export function createBrowserTool(presentation: ToolPresentation, io: CoreIo): ToolDefinition {
  return defineTool<typeof browserSchema, { browser: BrowserDetails }>({
    ...presentationOf(presentation),
    parameters: browserSchema,
    async execute(toolCallId, params, signal) {
      const abort = signal ?? new AbortController().signal;
      const label = params.description?.trim();
      const description = label === '' ? undefined : label;
      let result: BrowserRunResult;
      try {
        result = await io.browserRun(
          params.script,
          params.timeoutMs,
          { tool: 'Browser', toolCallId },
          abort,
        );
      } catch (error) {
        if (error instanceof AhpError && error.kind === 'hostUnavailable') {
          return {
            content: [{ type: 'text', text: BROWSER_UNAVAILABLE }],
            details: {
              browser: {
                ...(description === undefined ? {} : { description }),
                outcome: 'unavailable',
                images: 0,
              },
            },
            isError: true,
          };
        }
        throw error;
      }
      return {
        content: browserContent(result, randomBytes(6).toString('hex')),
        details: { browser: detailsOf(result, description) },
        isError: result.error != null,
      };
    },
  });
}
