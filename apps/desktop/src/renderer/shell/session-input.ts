// Sending the composer's input to a session (architecture sections 8.2, 8.3, 8.5; ADR-0030).
//
// - Idle: the input shows at once as an optimistic row; its attachments go to Core (which stores
//   them in the session's directory), then the prompt with the client's idempotency key. When
//   Core did not take it, the row stays as "not delivered" and can be sent again with the same
//   key, so a message whose answer was lost is not repeated.
// - Running: steering (Enter) and queueing (Mod+Enter) go to Core the same way; the queue above
//   the composer shows them until the model gets them.
// - Retry (error and uncertain cards): the turn's input again, as a new prompt.
import type { InputAttachment, InputMention } from '@piarc/protocol';

import type { OutgoingInput, PiarcApi } from '../../shared/ipc.js';
import type { AppStore } from '../store/app-store.js';
import {
  chipOf,
  storedAttachmentOf,
  type AttachmentChip,
  type DraftFiles,
  type QueuedInput,
} from '../store/transcript.js';
import { reason } from './errors.js';

type Api = Pick<
  PiarcApi,
  'prompt' | 'steer' | 'followUp' | 'storeAttachment' | 'resumeSession' | 'deleteQueueItem'
>;

/** An input on its way: what the user wrote and what is attached. */
export interface Draft extends DraftFiles {
  readonly text: string;
  readonly mentions: readonly InputMention[];
}

/**
 * The focus of a `/compact <focus>` typed into the composer and sent (the palette runs a bare
 * `/compact`; T27): the text after the command as written, `''` without one, undefined when
 * the draft is not this command (other text, mentions or attachments).
 */
export function compactFocus(draft: Draft): string | undefined {
  if (draft.mentions.length > 0 || draft.pending.length > 0 || draft.stored.length > 0) {
    return undefined;
  }
  const match = /^\s*\/compact(?:\s+([\s\S]*?))?\s*$/u.exec(draft.text);
  return match === null ? undefined : (match[1] ?? '');
}

function field(text: string, name: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && name in value) {
      const found = (value as Record<string, unknown>)[name];
      return typeof found === 'string' ? found : undefined;
    }
  } catch {
    // Not JSON: no field.
  }
  return undefined;
}

export function chipsOf(draft: Draft): AttachmentChip[] {
  return [
    ...draft.stored.flatMap(chipOf),
    ...draft.pending.map((file) => ({
      kind: file.kind,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    })),
  ];
}

/** Core's description of a stored attachment. */
function parseAttachment(text: string): InputAttachment {
  const [attachment] = storedAttachmentOf(JSON.parse(text));
  if (attachment === undefined) throw new Error('Core did not describe the attachment');
  return attachment;
}

/** One session's input path. Recovery data lives with the optimistic row until Core echoes it. */
export class SessionInput {
  private opening: Promise<string> | undefined;

  constructor(
    private readonly api: Api,
    private readonly store: AppStore,
    private readonly sessionId: string,
  ) {}

  /** Sends `draft` as a prompt (the session is idle). Never throws: failures show on the row. */
  async send(draft: Draft, clientId: string = crypto.randomUUID()): Promise<void> {
    const transcript = this.store.transcript(this.sessionId);
    if (transcript.row(`optimistic:${clientId}`) === undefined) {
      transcript.addOptimistic(clientId, {
        text: draft.text,
        mentions: draft.mentions,
        attachments: chipsOf(draft),
      });
    } else {
      transcript.markSending(clientId);
    }
    const stored = [...draft.stored];
    try {
      const input = await this.outgoing(clientId, draft, stored);
      const turnId = field(await this.api.prompt(this.sessionId, input), 'turnId');
      if (turnId === undefined) {
        throw new Error('Core did not confirm the prompt');
      }
      transcript.confirm(clientId, turnId, stored);
    } catch (error) {
      transcript.markUndelivered(clientId, reason(error), {
        stored,
        pending: draft.pending.slice(stored.length - draft.stored.length),
      });
    }
  }

  /** Sends an undelivered input again with the same idempotency key. */
  async resend(clientId: string): Promise<void> {
    const row = this.store.transcript(this.sessionId).row(`optimistic:${clientId}`);
    if (row?.kind === 'optimistic' && row.state === 'undelivered') {
      await this.send(
        { text: row.input.text, mentions: row.input.mentions, ...row.files },
        clientId,
      );
    }
  }

  /** Sends the input of turn `turnId` again as a new prompt. */
  async retry(turnId: string): Promise<void> {
    const found = this.store.transcript(this.sessionId).retryInput(turnId);
    if (found === undefined) {
      return;
    }
    await this.send({
      text: found.input.text,
      mentions: found.input.mentions,
      pending: [],
      stored: found.input.attachments,
    });
  }

  /** A steering message (`steer`) or a follow-up for the running turn. Throws when Core refuses. */
  async add(kind: 'steer' | 'followUp', draft: Draft): Promise<void> {
    const input = await this.outgoing(crypto.randomUUID(), draft);
    await (kind === 'steer'
      ? this.api.steer(this.sessionId, input)
      : this.api.followUp(this.sessionId, input));
  }

  /**
   * Sends a queued follow-up now: it leaves the queue and steers the running turn (the reference's
   * "Send now"). When Core refuses the steer, the input goes back into the queue (at its end, as a
   * follow-up again) and the error is thrown.
   */
  async sendNow(item: QueuedInput): Promise<void> {
    const input = (): OutgoingInput => ({
      requestId: crypto.randomUUID(),
      text: item.text,
      mentions: item.mentions,
      attachments: item.stored,
    });
    await this.api.deleteQueueItem(this.sessionId, item.itemId);
    try {
      await this.api.steer(this.sessionId, input());
    } catch (error) {
      await this.api.followUp(this.sessionId, input()).catch((requeue: unknown) => {
        console.error('[queue] putting a refused input back failed', requeue);
      });
      throw error;
    }
  }

  /** Opens the session in Core when it is not (a session from the list, never opened here). */
  async ensureOpen(): Promise<void> {
    if (this.store.session(this.sessionId)?.open === true) return;
    this.opening ??= this.api.resumeSession(this.sessionId).finally(() => {
      this.opening = undefined;
    });
    await this.opening;
  }

  /** The input for Core: stores the files first and remembers what was stored. */
  private async outgoing(
    clientId: string,
    draft: Draft,
    stored = [...draft.stored],
  ): Promise<OutgoingInput> {
    await this.ensureOpen();
    return prepareOutgoing(this.api, this.sessionId, clientId, draft, stored);
  }
}

/** Stores attachments in their owning session before handing Core the message. */
export async function prepareOutgoing(
  api: Pick<PiarcApi, 'storeAttachment'>,
  sessionId: string,
  clientId: string,
  draft: Draft,
  stored = [...draft.stored],
): Promise<OutgoingInput> {
  for (const file of draft.pending) {
    const bytes = new Uint8Array(await file.file.arrayBuffer());
    stored.push(
      parseAttachment(await api.storeAttachment(sessionId, file.name, file.mimeType, bytes)),
    );
  }
  return { requestId: clientId, text: draft.text, mentions: draft.mentions, attachments: stored };
}
