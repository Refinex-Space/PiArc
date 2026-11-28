// `session/title` (Core → Agent Host, ADR-0106): one request on the session's auxiliary model
// channel names a new session from its first message. Core decides when to ask (a new session's
// first message, never after a rename) and keeps the title; this module frames the message,
// asks, and reduces the answer to one clean line. An unusable answer is an empty title: the
// session keeps showing its first message. The usage is recorded like any auxiliary call
// (purpose `sessionTitle`).
import type { SessionTitleAnswer, SessionTitleParams } from '@piarc/protocol';

import type { AuxiliaryModel } from './auxiliary.js';
import { SESSION_TITLE_SYSTEM } from './prompts/session-title.js';

/** How long the request may take. */
export const SESSION_TITLE_TIMEOUT_MS = 30_000;
/** The longest answer, in tokens: a title is a few words, but a reasoning model thinks first. */
export const SESSION_TITLE_MAX_TOKENS = 512;
/** The most UTF-16 units of the message sent, and of the title returned. */
export const MESSAGE_LIMIT = 4000;
export const TITLE_LIMIT = 80;

/** Characters that may wrap a title as quotes. */
const QUOTES = /^["'`“”‘’「」『』《》〈〉]+|["'`“”‘’「」『』《》〈〉]+$/gu;
/** A leading label the model may add despite the instructions. */
const LABEL = /^(?:title|session title|标题|会话标题)\s*[:：]\s*/iu;
/** Closing punctuation of a sentence. */
const CLOSING = /[\s.。!！?？,，;；:：、…]+$/u;

/** The user message: the session's first message as material, its closing tag made inert. */
export function sessionTitlePrompt(text: string): string {
  const message = text
    .slice(0, MESSAGE_LIMIT)
    .toWellFormed()
    .split('</message>')
    .join('<\\/message>');
  return `<message>\n${message}\n</message>`;
}

/** The first line of `text` that has something on it, as a clean title; empty when none. */
export function tidyTitle(text: string): string {
  // A fenced answer counts by its content; Markdown emphasis and heading marks go.
  const lines = text
    .replace(/```[^\n]*\n?/gu, '')
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/^[#>*\-\s]+/u, '')
        .replace(/[*_`]/gu, '')
        .trim(),
    )
    .filter((line) => line !== '');
  let title = (lines[0] ?? '').replace(LABEL, '');
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  title = title.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ');
  title = title.replace(QUOTES, '').trim().replace(CLOSING, '').replace(QUOTES, '').trim();
  if (title.length > TITLE_LIMIT) {
    // Cut on a code point, not inside a surrogate pair.
    let cut = '';
    for (const char of title) {
      if (cut.length + char.length > TITLE_LIMIT) break;
      cut += char;
    }
    title = cut.trimEnd();
  }
  return title.toWellFormed();
}

/** Asks the session's auxiliary model for a title. */
export async function generateSessionTitle(
  params: SessionTitleParams,
  auxiliary: AuxiliaryModel,
  signal: AbortSignal = AbortSignal.timeout(SESSION_TITLE_TIMEOUT_MS),
): Promise<SessionTitleAnswer> {
  const answer = await auxiliary.complete({
    purpose: 'sessionTitle',
    system: SESSION_TITLE_SYSTEM,
    prompt: sessionTitlePrompt(params.text),
    signal,
    maxTokens: SESSION_TITLE_MAX_TOKENS,
  });
  return { title: tidyTitle(answer.text), model: answer.model };
}
