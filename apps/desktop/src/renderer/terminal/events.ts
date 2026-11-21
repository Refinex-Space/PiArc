// The events of the terminals the window shows (`term/<id>`, `piarc_protocol::terminal::
// TerminalEvent`). `window.piarc.subscribeEvents` keeps one listener per route, so this hub
// subscribes once per terminal and hands each event to every part of the panel that listens
// (the tab's title, the view's wake-up), unsubscribing with the last of them.
export type TerminalEvent =
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'pwd'; readonly path: string }
  | { readonly type: 'bell' }
  | { readonly type: 'clipboard'; readonly text: string }
  | { readonly type: 'output' }
  | { readonly type: 'exited' }
  | { readonly type: 'other' };

type Listener = (event: TerminalEvent) => void;

const listeners = new Map<number, Set<Listener>>();

/** The client's form of one event object, or undefined when it is malformed. */
export function terminalEventOf(value: unknown): TerminalEvent | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined;
  switch (value.type) {
    case 'title':
      return 'title' in value && typeof value.title === 'string'
        ? { type: 'title', title: value.title }
        : undefined;
    case 'pwd':
      return 'path' in value && typeof value.path === 'string'
        ? { type: 'pwd', path: value.path }
        : undefined;
    case 'clipboard':
      return 'text' in value && typeof value.text === 'string'
        ? { type: 'clipboard', text: value.text }
        : undefined;
    case 'bell':
    case 'output':
    case 'exited':
      return { type: value.type };
    default:
      return { type: 'other' };
  }
}

function deliver(id: number, payload: Uint8Array): void {
  let events: unknown;
  try {
    events = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!Array.isArray(events)) return;
  for (const value of events as unknown[]) {
    const event = terminalEventOf(value);
    if (event === undefined) continue;
    for (const listener of [...(listeners.get(id) ?? [])]) listener(event);
  }
}

/** Listens to terminal `id`'s events; returns the function that stops. */
export function onTerminalEvents(id: number, listener: Listener): () => void {
  let set = listeners.get(id);
  if (set === undefined) {
    set = new Set();
    listeners.set(id, set);
    window.piarc
      .subscribeEvents(`term/${String(id)}`, (batch) => {
        deliver(id, batch.payload);
      })
      .catch((error: unknown) => {
        console.error('[terminal] cannot follow terminal events', error);
      });
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(id) === set) {
      listeners.delete(id);
      void window.piarc.unsubscribeEvents(`term/${String(id)}`).catch(() => undefined);
    }
  };
}
