// The new-session flow (architecture section 8.2): the user's message is shown at once with a
// `clientId` → the session is created → the message is sent as its first prompt. A failure at
// any step rolls the optimistic message back and gives the text back to the input; a session
// that was created but did not take its first prompt is closed again (Pi keeps no file for a
// session without a reply, so it leaves no trace).
import type { PiarcApi } from '../../shared/ipc.js';
import type { AppStore } from '../store/app-store.js';

export type StartStep =
  | { readonly kind: 'echo'; readonly clientId: string; readonly text: string }
  | { readonly kind: 'created'; readonly sessionId: string };

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

/**
 * Starts a session in `workspace` with `text`. `onStep` hears when the echo shows and when the
 * session exists (the view switches to it). Resolves with the session id; rejects after rolling
 * back.
 */
export async function startSession(options: {
  readonly api: Pick<PiarcApi, 'createSession' | 'prompt' | 'closeSession'>;
  readonly store: AppStore;
  readonly workspace: string;
  readonly text: string;
  readonly clientId: string;
  readonly watch: (sessionId: string) => () => void;
  readonly onStep: (step: StartStep) => void;
}): Promise<string> {
  const { api, store, workspace, text, clientId } = options;
  options.onStep({ kind: 'echo', clientId, text });
  const sessionId = field(await api.createSession(workspace), 'sessionId');
  if (sessionId === undefined) {
    throw new Error('Core did not return a session id');
  }
  const transcript = store.transcript(sessionId);
  transcript.addOptimistic(clientId, text);
  const unwatch = options.watch(sessionId);
  options.onStep({ kind: 'created', sessionId });
  try {
    const turnId = field(await api.prompt(sessionId, text), 'turnId');
    if (turnId !== undefined) {
      transcript.confirm(clientId, turnId);
    }
    return sessionId;
  } catch (error) {
    transcript.rollback(clientId);
    unwatch();
    api.closeSession(sessionId).catch((closeError: unknown) => {
      console.error('[start] closing the session that did not start failed', closeError);
    });
    throw error;
  }
}
