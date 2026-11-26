// `session/gitAssist` (Core → Agent Host, ADR-0087): one request on the session's auxiliary model
// channel writes a pull request's title and body, or reviews a diff. Core already chose, cut and
// redacted the diff and left out sensitive files; this module frames the material, asks, and
// reads the answer: a title line and a Markdown body, or the review's JSON, parsed leniently
// (Core checks every finding against the diff). The usage is recorded like any auxiliary call
// (purpose `prDescription` or `review`).
import type {
  GitAssistAnswer,
  GitAssistFinding,
  GitAssistParams,
  GitFindingSeverity,
} from '@piarc/protocol';

import type { ModelPreferencesStore } from '../providers/preferences.js';
import type { AuxiliaryModel } from './auxiliary.js';
import { ASSIST_LANGUAGE, PR_DESCRIPTION_SYSTEM, REVIEW_SYSTEM } from './prompts/git-assist.js';

/** How long each kind of request may take. */
export const GIT_ASSIST_TIMEOUT_MS = { prDescription: 60_000, review: 120_000 } as const;
/** The longest answer of each kind, in tokens. */
export const GIT_ASSIST_MAX_TOKENS = { prDescription: 1500, review: 4000 } as const;
/** The most UTF-16 units of a title, a body, a summary and a finding's text. */
const LIMITS = { title: 256, body: 16 * 1024, summary: 2048, findingTitle: 200, findingBody: 2048 };
/** The most findings kept. */
const MAX_FINDINGS = 30;

export interface GitAssistContext {
  readonly auxiliary: AuxiliaryModel;
  readonly preferences: ModelPreferencesStore;
}

function inert(text: string, tag: string): string {
  return text.split(`</${tag}>`).join(`<\\/${tag}>`);
}

function block(tag: string, body: string): string {
  return `<${tag}>\n${inert(body, tag)}\n</${tag}>`;
}

/** `text` without control characters (line breaks and tabs kept), cut to `limit`. */
function tidy(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  let out = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').trim();
  if (out.length > limit) out = out.slice(0, limit).trimEnd();
  return out.toWellFormed();
}

/** The user message: instructions, language, branches, commits, files and diff. */
export function gitAssistPrompt(params: GitAssistParams): string {
  const parts: string[] = [];
  if (params.task === 'prDescription' && params.instructions.trim() !== '') {
    parts.push(block('instructions', params.instructions.trim()));
  }
  parts.push(ASSIST_LANGUAGE[params.language]);
  if (params.branch != null) parts.push(`Branch: ${params.branch}`);
  if (params.base != null) parts.push(`Compared with: ${params.base}`);
  if (params.commits.length > 0) {
    parts.push(block('commits', params.commits.map((s) => `- ${s}`).join('\n')));
  }
  const files = params.files.map((file) => {
    const counts =
      file.added == null ? '' : ` (+${String(file.added)} −${String(file.removed ?? 0)})`;
    const withheld = file.withheld == null ? '' : ` [content withheld: ${file.withheld}]`;
    return `- ${file.status} ${file.path}${counts}${withheld}`;
  });
  parts.push(block('files', files.join('\n')));
  parts.push(block('diff', params.diff));
  return parts.join('\n\n');
}

/** A PR answer: the first non-empty line is the title, the rest the body. */
export function parseDescription(text: string): { title: string; body: string } {
  let out = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(out);
  if (fenced?.[1] !== undefined) out = fenced[1].trim();
  const lines = out.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const raw = first < 0 ? '' : (lines[first] ?? '');
  const title = raw
    .replace(/^#+\s*/u, '')
    .replace(/^(title|标题)\s*[:：]\s*/iu, '')
    .replace(/^["'“]|["'”]$/gu, '')
    .trim();
  const body =
    first < 0
      ? ''
      : lines
          .slice(first + 1)
          .join('\n')
          .trim();
  return { title: tidy(title, LIMITS.title), body: tidy(body, LIMITS.body) };
}

const SEVERITIES: readonly GitFindingSeverity[] = ['high', 'medium', 'low'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A review answer: the first JSON object in the text, findings with the expected fields. */
export function parseReview(text: string): { summary: string; findings: GitAssistFinding[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let value: unknown;
  try {
    value = start < 0 || end <= start ? undefined : JSON.parse(text.slice(start, end + 1));
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) return { summary: tidy(text, LIMITS.summary), findings: [] };
  const findings: GitAssistFinding[] = [];
  for (const item of Array.isArray(value.findings) ? value.findings : []) {
    if (!isRecord(item)) continue;
    const severity = SEVERITIES.find((s) => s === item.severity);
    const line = typeof item.line === 'number' ? Math.trunc(item.line) : Number.NaN;
    if (
      typeof item.path !== 'string' ||
      severity === undefined ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      typeof item.title !== 'string'
    ) {
      continue;
    }
    findings.push({
      path: item.path.trim(),
      line,
      severity,
      title: tidy(item.title, LIMITS.findingTitle),
      body: tidy(typeof item.body === 'string' ? item.body : '', LIMITS.findingBody),
    });
    if (findings.length === MAX_FINDINGS) break;
  }
  const summary = typeof value.summary === 'string' ? tidy(value.summary, LIMITS.summary) : '';
  return { summary, findings };
}

/** Asks the session's auxiliary model for a PR description or a review. */
export async function generateGitAssist(
  params: GitAssistParams,
  context: GitAssistContext,
  signal: AbortSignal = AbortSignal.timeout(GIT_ASSIST_TIMEOUT_MS[params.task]),
): Promise<GitAssistAnswer> {
  const answer = await context.auxiliary.complete({
    purpose: params.task,
    system: params.task === 'review' ? REVIEW_SYSTEM : PR_DESCRIPTION_SYSTEM,
    prompt: gitAssistPrompt(params),
    signal,
    maxTokens: GIT_ASSIST_MAX_TOKENS[params.task],
  });
  const chosen = context.preferences.auxiliary;
  const fallback =
    chosen !== undefined &&
    (chosen.provider !== answer.model.provider || chosen.id !== answer.model.id);
  const written =
    params.task === 'review'
      ? parseReview(answer.text)
      : { ...parseDescription(answer.text), findings: [] };
  return {
    ...written,
    model: answer.model,
    ...(fallback ? { fallback: true } : {}),
  };
}
