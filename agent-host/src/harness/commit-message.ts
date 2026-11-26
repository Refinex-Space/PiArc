// `session/commitMessage` (Core → Agent Host, ADR-0086): one request on the session's
// auxiliary model channel writes a commit message for the staged changes Core collected. Core
// already cut and redacted the diff and left out sensitive files; this module only frames the
// material, asks, and tidies the answer. The usage is recorded like any auxiliary call
// (purpose `commitMessage`).
import type { CommitMessageAnswer, CommitMessageParams } from '@piarc/protocol';

import type { ModelPreferencesStore } from '../providers/preferences.js';
import type { AuxiliaryModel } from './auxiliary.js';
import { AMEND_NOTE, COMMIT_MESSAGE_SYSTEM, LANGUAGE_REQUIREMENT } from './prompts/commit-message.js';

/** How long the request may take. */
export const COMMIT_MESSAGE_TIMEOUT_MS = 60_000;
/** The longest answer, in tokens. */
export const COMMIT_MESSAGE_MAX_TOKENS = 600;
/** The most UTF-16 units of the message returned. */
const MESSAGE_LIMIT = 4096;

export interface CommitMessageContext {
  readonly auxiliary: AuxiliaryModel;
  readonly preferences: ModelPreferencesStore;
}

/** `text` with the closing tag of `tag` made inert, so material cannot end its block. */
function inert(text: string, tag: string): string {
  return text.split(`</${tag}>`).join(`<\\/${tag}>`);
}

function block(tag: string, body: string): string {
  return `<${tag}>\n${inert(body, tag)}\n</${tag}>`;
}

function fileLine(file: CommitMessageParams['files'][number]): string {
  const counts =
    file.added == null ? '' : ` (+${String(file.added)} −${String(file.removed ?? 0)})`;
  const withheld = file.withheld == null ? '' : ` [content withheld: ${file.withheld}]`;
  return `- ${file.status} ${file.path}${counts}${withheld}`;
}

/** The user message: instructions, language, branch, style hints, files and diff. */
export function commitMessagePrompt(params: CommitMessageParams): string {
  const parts: string[] = [];
  if (params.instructions.trim() !== '') parts.push(block('instructions', params.instructions.trim()));
  parts.push(LANGUAGE_REQUIREMENT[params.language]);
  if (params.branch != null) parts.push(`Branch: ${params.branch}`);
  if (params.recentSubjects.length > 0) {
    parts.push(block('recent_subjects', params.recentSubjects.map((s) => `- ${s}`).join('\n')));
  }
  parts.push(block('files', params.files.map(fileLine).join('\n')));
  if (params.amend != null) {
    parts.push(block('previous_message', params.amend));
    parts.push(AMEND_NOTE);
  }
  parts.push(block('diff', params.diff));
  return parts.join('\n\n');
}

/** The answer without code fences, surrounding quotes or control characters, cut to size. */
export function tidyMessage(text: string): string {
  let out = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(out);
  if (fenced?.[1] !== undefined) out = fenced[1].trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1).trim();
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
  if (out.length > MESSAGE_LIMIT) out = out.slice(0, MESSAGE_LIMIT).trimEnd();
  return out.toWellFormed();
}

/** Asks the session's auxiliary model for the message. */
export async function generateCommitMessage(
  params: CommitMessageParams,
  context: CommitMessageContext,
  signal: AbortSignal = AbortSignal.timeout(COMMIT_MESSAGE_TIMEOUT_MS),
): Promise<CommitMessageAnswer> {
  const answer = await context.auxiliary.complete({
    purpose: 'commitMessage',
    system: COMMIT_MESSAGE_SYSTEM,
    prompt: commitMessagePrompt(params),
    signal,
    maxTokens: COMMIT_MESSAGE_MAX_TOKENS,
  });
  const chosen = context.preferences.auxiliary;
  const fallback =
    chosen !== undefined &&
    (chosen.provider !== answer.model.provider || chosen.id !== answer.model.id);
  return {
    text: tidyMessage(answer.text),
    model: answer.model,
    ...(fallback ? { fallback: true } : {}),
  };
}
