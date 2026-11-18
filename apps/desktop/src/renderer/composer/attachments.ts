// Attachments in the composer (ADR-0030): which files can be attached comes from Core
// (`composerInfo().attachments`, the single definition of the types and limits); the composer
// checks dropped and pasted files against it at once, so the user sees why a file was refused
// before anything is sent. Core checks again when it stores the file.
import type { PaletteCommand } from './command-plugin.js';

export type AttachmentKind = 'image' | 'pdf';

export interface AttachmentLimits {
  readonly maxCount: number;
  readonly kinds: readonly {
    readonly kind: AttachmentKind;
    readonly mimeTypes: readonly string[];
    readonly maxBytes: number;
  }[];
}

/** A file waiting in the composer. */
export interface PendingAttachment {
  readonly id: string;
  readonly file: Blob;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: AttachmentKind;
}

export type AttachmentProblem =
  | { readonly reason: 'type'; readonly name: string }
  | { readonly reason: 'size'; readonly name: string; readonly maxBytes: number }
  | { readonly reason: 'count'; readonly maxCount: number };

/** The composer's configuration from Core. */
export interface ComposerInfo {
  readonly commands: readonly PaletteCommand[];
  readonly limits: AttachmentLimits;
  readonly maxSearchResults: number;
}

/** A file as the browser gives it (`File`): its name, declared type and size. */
export interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** The file's media type: the declared one, or the one its extension implies. */
export function mimeTypeOf(file: FileLike): string {
  if (file.type !== '') {
    return file.type;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Splits `files` into the ones that can be attached (given `current` already attached) and
 * the reasons the others cannot.
 */
export function checkFiles(
  files: readonly (FileLike & Blob)[],
  current: number,
  limits: AttachmentLimits,
  newId: () => string,
): { accepted: PendingAttachment[]; problems: AttachmentProblem[] } {
  const accepted: PendingAttachment[] = [];
  const problems: AttachmentProblem[] = [];
  for (const file of files) {
    const mimeType = mimeTypeOf(file);
    const kind = limits.kinds.find((entry) => entry.mimeTypes.includes(mimeType));
    if (kind === undefined) {
      problems.push({ reason: 'type', name: file.name });
    } else if (file.size === 0 || file.size > kind.maxBytes) {
      problems.push({ reason: 'size', name: file.name, maxBytes: kind.maxBytes });
    } else if (current + accepted.length >= limits.maxCount) {
      problems.push({ reason: 'count', maxCount: limits.maxCount });
      break;
    } else {
      accepted.push({
        id: newId(),
        file,
        name: file.name,
        mimeType,
        size: file.size,
        kind: kind.kind,
      });
    }
  }
  return { accepted, problems };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses Core's `composerInfo()` answer; malformed parts become empty. */
export function parseComposerInfo(text: string): ComposerInfo {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = {};
  }
  const info = isRecord(value) ? value : {};
  const commands = Array.isArray(info.commands)
    ? info.commands.flatMap((command: unknown) =>
        isRecord(command) &&
        typeof command.name === 'string' &&
        typeof command.description === 'string' &&
        typeof command.source === 'string' &&
        typeof command.action === 'string'
          ? [
              {
                name: command.name,
                description: command.description,
                source: command.source,
                action: command.action,
              },
            ]
          : [],
      )
    : [];
  const attachments = isRecord(info.attachments) ? info.attachments : {};
  const kinds = Array.isArray(attachments.kinds)
    ? attachments.kinds.flatMap((entry: unknown) => {
        const kind = isRecord(entry) ? kindOf(entry.kind) : undefined;
        return isRecord(entry) &&
          kind !== undefined &&
          Array.isArray(entry.mimeTypes) &&
          typeof entry.maxBytes === 'number'
          ? [
              {
                kind,
                mimeTypes: entry.mimeTypes.filter((t): t is string => typeof t === 'string'),
                maxBytes: entry.maxBytes,
              },
            ]
          : [];
      })
    : [];
  const search = isRecord(info.fileSearch) ? info.fileSearch : {};
  return {
    commands,
    limits: {
      maxCount: typeof attachments.maxCount === 'number' ? attachments.maxCount : 0,
      kinds,
    },
    maxSearchResults: typeof search.maxResults === 'number' ? search.maxResults : 20,
  };
}

function kindOf(value: unknown): AttachmentKind | undefined {
  return value === 'image' || value === 'pdf' ? value : undefined;
}
