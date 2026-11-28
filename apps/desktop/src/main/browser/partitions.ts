// The built-in browser's Chromium partitions (ADR-0088 rules 1 and 2). A guest lives in a
// partition of its workspace; the agent's script host in its own. A webContents is a browser
// guest because of its session, which is known when `web-contents-created` fires, so the
// app's navigation guard and the terminal's input watch never see a guest.
import { createHash } from 'node:crypto';

import { session as sessions, type Session } from 'electron';

/** How a workspace's browsing data is kept (B5.5): on disk, or until PiArc quits. */
export type BrowserStorage = 'persist' | 'session';

/** The partition of the agent's script host (B2): in memory, no network. */
export const HOST_PARTITION = 'piarc-browser-host';
/** The partition of the shield over a page the agent is driving (B2.5.1): empty, no script. */
export const SHIELD_PARTITION = 'piarc-browser-shield';

/** The key of a workspace's partition: Core's proxy is named by it. */
export function partitionKey(workspace: string, storage: BrowserStorage): string {
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  return storage === 'persist' ? `piarc-browser-${hash}` : `piarc-browser-mem-${hash}`;
}

/** Electron's partition string for `key`. */
export function partitionName(key: string, storage: BrowserStorage): string {
  return storage === 'persist' ? `persist:${key}` : key;
}

export type PartitionKind = 'guest' | 'host';

/** The sessions the browser created, by kind. */
export class BrowserPartitions {
  readonly #guests = new WeakSet<Session>();
  readonly #hosts = new WeakSet<Session>();
  readonly #keys = new WeakMap<Session, string>();

  /** The guest session of `key`, set up by `setup` the first time it is asked for. */
  guest(key: string, storage: BrowserStorage, setup: (session: Session) => void): Session {
    const session = sessions.fromPartition(partitionName(key, storage));
    if (!this.#guests.has(session)) {
      this.#guests.add(session);
      this.#keys.set(session, key);
      setup(session);
    }
    return session;
  }

  /** The script host's session, set up by `setup` the first time. */
  host(setup: (session: Session) => void): Session {
    const session = sessions.fromPartition(HOST_PARTITION);
    if (!this.#hosts.has(session)) {
      this.#hosts.add(session);
      setup(session);
    }
    return session;
  }

  /** The shield's session: refuses every request and permission. */
  shield(): Session {
    const session = sessions.fromPartition(SHIELD_PARTITION);
    if (!this.#hosts.has(session)) {
      this.#hosts.add(session);
      session.webRequest.onBeforeRequest((_details, callback) => {
        callback({ cancel: true });
      });
      session.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      session.setPermissionCheckHandler(() => false);
    }
    return session;
  }

  kind(session: Session): PartitionKind | undefined {
    if (this.#guests.has(session)) return 'guest';
    if (this.#hosts.has(session)) return 'host';
    return undefined;
  }

  keyOf(session: Session): string | undefined {
    return this.#keys.get(session);
  }
}
