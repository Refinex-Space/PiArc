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
import { chipOf, type AttachmentChip, type DraftFiles } from '../store/transcript.js';
import { reason } from './errors.js';

type Api = Pick<PiarcApi, 'prompt' | 'steer' | 'followUp' | 'storeAttachment' | 'resumeSession'>;

/** An input on its way: what the user wrote and what is attached. */
export interface Draft extends DraftFiles {
  readonly text: string;
  readonly mentions: readonly InputMention[];
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

function chipsOf(draft: Draft): AttachmentChip[] {
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
  const value: unknown = JSON.parse(text);
  const [chip] = chipOf(value);
  if (
    chip === undefined ||
    typeof value !== 'object' ||
    value === null ||
    !('blob' in value) ||
    typeof value.blob !== 'object' ||
    value.blob === null
  ) {
    throw new Error('Core did not describe the attachment');
  }
  const blob = value.blob as Record<string, unknown>;
  if (
    typeof blob.path !== 'string' ||
    typeof blob.sha256 !== 'string' ||
    typeof blob.size !== 'number'
  ) {
    throw new Error('Core did not describe the attachment');
  }
  return {
    kind: chip.kind,
    name: chip.name,
    mimeType: chip.mimeType,
    blob: { path: blob.path, sha256: blob.sha256, size: blob.size },
    ...(chip.pageCount === undefined ? {} : { pageCount: chip.pageCount }),
  };
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
    for (const file of draft.pending) {
      const bytes = new Uint8Array(await file.file.arrayBuffer());
      stored.push(
        parseAttachment(
          await this.api.storeAttachment(this.sessionId, file.name, file.mimeType, bytes),
        ),
      );
    }
    return { requestId: clientId, text: draft.text, mentions: draft.mentions, attachments: stored };
  }
}
