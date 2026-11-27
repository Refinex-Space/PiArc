import type { Node } from 'prosemirror-model';
import type { PendingAttachment } from './attachments.js';
import type { PendingBrowserContext } from './browser-context.js';
import type { ComposerSubmission, MentionSource } from './Composer.js';
import type { Draft } from '../shell/session-input.js';
import type { MentionData } from './schema.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's file search as the composer's `@` source, below the session's working directory. */
export function coreMentions(root: string | undefined, limit: number): MentionSource {
  const searchId = `mention-${crypto.randomUUID()}`;
  return {
    search: async (query) => {
      if (root === undefined) {
        return [];
      }
      const value: unknown = JSON.parse(
        await window.piarc.searchFiles(searchId, root, query, limit),
      );
      const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
      return results.flatMap((result: unknown): MentionData[] =>
        isRecord(result) && typeof result.path === 'string' && typeof result.name === 'string'
          ? [{ id: result.path, label: result.name, path: result.path }]
          : [],
      );
    },
    cancel: () => {
      window.piarc.cancelFileSearch(searchId).catch((error: unknown) => {
        console.error('[conversation] cannot cancel the file search', error);
      });
    },
  };
}

export function draftOf(submission: ComposerSubmission): Draft {
  return {
    text: submission.text,
    mentions: submission.spans,
    pending: submission.attachments,
    stored: [],
  };
}

/** Draft content held by its workspace or session in this window. */
export interface EditorDraft {
  doc?: Node;
  files?: readonly PendingAttachment[];
  /** Browser context attachments (B3.5). */
  contexts?: readonly PendingBrowserContext[];
}
