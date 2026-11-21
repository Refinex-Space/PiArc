// The user's input as the model receives it (ADR-0030): the text the user wrote, image
// attachments as image content of the user message, and the text of attached PDFs after the
// user's text (pi-ai 1.5.2 has no document content, so PDFs always go as their pages' text,
// read through Core's `fs/pdf` like the Read tool does).
//
// What the user wrote, the files it mentions and the attachments are kept beside the
// conversation as a `piarc.input` custom entry, written just before Pi persists the user
// message; the live projection and the history read the same record to show the message as the
// user wrote it (mention chips, attachment chips) rather than as the model received it.
import os from 'node:os';
import path from 'node:path';

import type { ImageContent } from '@earendil-works/pi-ai';
import type {
  BlobRef,
  FsPdfResult,
  InputAttachment,
  InputMention,
  PromptCommand,
} from '@piarc/protocol';

import { isObject } from './items.js';

/** The custom entry type that records a user input's own text, mentions and attachments. */
export const INPUT_ENTRY = 'piarc.input';

/** The most pages of an attached PDF whose text the model receives with the message. */
export const MAX_PDF_PAGES = 20;

/** The user's input as Core sent it. */
export interface UserInput {
  readonly text: string;
  readonly mentions: readonly InputMention[];
  readonly attachments: readonly InputAttachment[];
  /** The slash command Core expanded into `text` (T37): what the user typed is
   * `command.input`. */
  readonly command?: PromptCommand;
}

/** An input ready for Pi. */
export interface PreparedInput {
  /** What the user wrote. */
  readonly input: UserInput;
  /** The PDFs' text that follows the user's text (empty without PDFs). */
  readonly sections: string;
  /** Image content of the user message. */
  readonly images: readonly ImageContent[];
  /** Context `UserPromptSubmit` hooks added (Core), delivered with the input. */
  readonly hookContext?: string;
}

/** What reading the attachments needs. */
export interface AttachmentReader {
  readBlob(blob: BlobRef): Promise<Buffer>;
  pdf(path: string, pages: string): Promise<FsPdfResult>;
}

/** Text without mentions or attachments, ready for Pi. */
export function plainInput(text: string): PreparedInput {
  return { input: { text, mentions: [], attachments: [] }, sections: '', images: [] };
}

/** The text Pi gets: the user's text, then the PDFs' pages. */
export function composedText(prepared: PreparedInput): string {
  return prepared.input.text + prepared.sections;
}

/** The record kept for the user message; undefined for plain text (nothing to show). */
export function inputRecord(prepared: PreparedInput): UserInput | undefined {
  const { input } = prepared;
  // A command shows as the user typed it, not as its expansion (T37).
  if (input.command !== undefined) return { ...input, text: input.command.input };
  return input.mentions.length === 0 && input.attachments.length === 0 ? undefined : input;
}

/** Reads the attachments of `input`. */
export async function prepareInput(
  input: UserInput,
  reader: AttachmentReader,
): Promise<PreparedInput> {
  const images: ImageContent[] = [];
  let sections = '';
  for (const attachment of input.attachments) {
    if (attachment.kind === 'image') {
      const bytes = await reader.readBlob(attachment.blob);
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: attachment.mimeType });
    } else {
      const count = Math.max(1, attachment.pageCount ?? 1);
      const last = Math.min(count, MAX_PDF_PAGES);
      const result = await reader.pdf(attachment.blob.path, `1-${String(last)}`);
      sections += pdfSection(attachment, result);
    }
  }
  return { input, sections, images };
}

/** The same input with new text: mentions are dropped (their spans no longer match). */
export function withText(prepared: PreparedInput, text: string): PreparedInput {
  return { ...prepared, input: { ...prepared.input, text, mentions: [] } };
}

/** A PDF's pages as the model reads them after the user's text. */
export function pdfSection(attachment: InputAttachment, result: FsPdfResult): string {
  const where = modelPath(attachment.blob.path);
  const lines = [
    '',
    '',
    `<attachment name="${quoted(attachment.name)}" type="application/pdf" pages="${String(result.pageCount)}" path="${quoted(where)}">`,
  ];
  for (const page of result.pages) {
    lines.push(`[Page ${String(page.number)}]`, page.text === '' ? '(no text)' : page.text, '');
  }
  const shown = result.pages.length;
  if (result.pageCount > shown) {
    lines.push(
      `Pages ${String(shown + 1)}-${String(result.pageCount)} are not included above. Read them from the path above with the Read tool and its pages parameter.`,
    );
  }
  lines.push('</attachment>');
  return lines.join('\n').toWellFormed();
}

/** The record of a `piarc.input` custom entry, or undefined when it is not one. */
export function parseInputRecord(data: unknown): UserInput | undefined {
  if (!isObject(data) || typeof data.text !== 'string') {
    return undefined;
  }
  const mentions = Array.isArray(data.mentions) ? data.mentions.flatMap(mentionOf) : [];
  const attachments = Array.isArray(data.attachments) ? data.attachments.flatMap(attachmentOf) : [];
  const command = commandOf(data.command);
  return { text: data.text, mentions, attachments, ...(command === undefined ? {} : { command }) };
}

const COMMAND_KINDS: readonly PromptCommand['kind'][] = [
  'builtIn',
  'command',
  'skill',
  'mcpPrompt',
];
const SOURCES: readonly PromptCommand['source'][] = [
  'builtIn',
  'projectPiarc',
  'projectClaude',
  'projectPi',
  'user',
  'userClaude',
  'userPi',
  'plugin',
  'mcp',
];

const isKind = (value: unknown): value is PromptCommand['kind'] =>
  COMMAND_KINDS.some((kind) => kind === value);
const isSource = (value: unknown): value is PromptCommand['source'] =>
  SOURCES.some((source) => source === value);

/** A slash command of an input (`session/prompt` and `piarc.input`, T37). */
export function commandOf(value: unknown): PromptCommand | undefined {
  if (
    !isObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.input !== 'string' ||
    !isKind(value.kind) ||
    !isSource(value.source) ||
    !(value.arguments == null || typeof value.arguments === 'string')
  ) {
    return undefined;
  }
  return {
    name: value.name,
    kind: value.kind,
    source: value.source,
    input: value.input,
    ...(typeof value.arguments === 'string' && value.arguments !== ''
      ? { arguments: value.arguments }
      : {}),
  };
}

function mentionOf(value: unknown): InputMention[] {
  if (
    isObject(value) &&
    typeof value.path === 'string' &&
    isOffset(value.start) &&
    isOffset(value.end) &&
    value.start <= value.end
  ) {
    return [{ path: value.path, start: value.start, end: value.end }];
  }
  return [];
}

function attachmentOf(value: unknown): InputAttachment[] {
  if (
    !isObject(value) ||
    (value.kind !== 'image' && value.kind !== 'pdf') ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !isObject(value.blob) ||
    typeof value.blob.path !== 'string' ||
    typeof value.blob.sha256 !== 'string' ||
    !isOffset(value.blob.size)
  ) {
    return [];
  }
  const blob = { path: value.blob.path, sha256: value.blob.sha256, size: value.blob.size };
  return [
    {
      kind: value.kind,
      name: value.name,
      mimeType: value.mimeType,
      blob,
      ...(isOffset(value.pageCount) ? { pageCount: value.pageCount } : {}),
    },
  ];
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A path under the home directory as `~/…` (the model does not need the user's name). */
function modelPath(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  if (home !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return file;
}

function quoted(text: string): string {
  return text.replaceAll('"', '&quot;');
}
