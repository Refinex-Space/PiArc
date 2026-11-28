// The out-of-process frames of a tab (design addendum B2.4): a snapshot stitches each
// cross-site iframe's document under its `<iframe>` element, so it needs the frame's own
// DevTools session. The tab's debugger auto-attaches frames (flattened, without pausing them)
// the first time a snapshot asks, and this tracker keeps the attached sessions per page.

import type { WebContents } from 'electron';

import type { FrameSession } from './snapshot.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FrameTracker {
  readonly #frames = new WeakMap<WebContents, Map<string, FrameSession>>();
  readonly #ready = new WeakMap<WebContents, Promise<void>>();

  /** The attached frame sessions of `contents`, starting auto-attach on first use. */
  async of(contents: WebContents): Promise<readonly FrameSession[]> {
    let ready = this.#ready.get(contents);
    if (ready === undefined) {
      ready = this.#start(contents);
      ready.catch(() => this.#ready.delete(contents));
      this.#ready.set(contents, ready);
    }
    await ready;
    return [...(this.#frames.get(contents)?.values() ?? [])];
  }

  async #start(contents: WebContents): Promise<void> {
    const frames = new Map<string, FrameSession>();
    this.#frames.set(contents, frames);
    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    dbg.on('message', (_event, method: string, params: unknown, sessionId: string) => {
      if (!isRecord(params)) return;
      if (method === 'Target.attachedToTarget') {
        const info = params.targetInfo;
        if (
          typeof params.sessionId === 'string' &&
          isRecord(info) &&
          info.type === 'iframe' &&
          typeof info.targetId === 'string'
        ) {
          frames.set(params.sessionId, {
            sessionId: params.sessionId,
            targetId: info.targetId,
            url: typeof info.url === 'string' ? info.url : '',
          });
          // Frames inside the frame attach too, and nothing waits for a debugger.
          dbg
            .sendCommand(
              'Target.setAutoAttach',
              { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
              params.sessionId,
            )
            .catch(() => undefined);
        }
      } else if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
        frames.delete(params.sessionId);
      } else if (method === 'Page.frameNavigated' && sessionId === '') {
        // A new top document: frame sessions of the old one detach on their own.
      }
    });
    await dbg.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
  }
}
