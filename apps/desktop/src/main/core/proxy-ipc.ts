// The Agent Hosts' proxy (ADR-0082). With the user's choice at `auto` they use the system's
// proxy, which only the main process can resolve: Electron answers for the system settings and
// PAC. The main process resolves it at start, when a window comes to the front (at most every
// 30 s) and when the proxy settings page asks, and tells Core, which restarts idle Agent Hosts
// on a change.
import type { Session } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';

/** The kind of address the proxy is resolved for: a model provider's. */
const PROBE_URL = 'https://api.openai.com/';

/** A window coming to the front resolves the proxy again at most this often (ms). */
const FOCUS_INTERVAL_MS = 30_000;

/**
 * The first proxy Node can use in Chromium's answer (`PROXY host:port; DIRECT`): `http://` for
 * `PROXY`, `https://` for `HTTPS`; `null` when `DIRECT` comes first. SOCKS entries are skipped:
 * Node's proxy support has no SOCKS.
 */
export function proxyFromRules(rules: string): string | null {
  for (const entry of rules.split(';')) {
    const [kind = '', address = ''] = entry.trim().split(/\s+/u);
    switch (kind.toUpperCase()) {
      case 'DIRECT':
        return null;
      case 'PROXY':
        return address === '' ? null : `http://${address}`;
      case 'HTTPS':
        return address === '' ? null : `https://${address}`;
      default:
        break;
    }
  }
  return null;
}

/** What the proxy needs of Core's module. */
export interface ProxyCore {
  setSystemProxy(url?: string | null): void;
}

/** The system's proxy, resolved through a session and handed to Core. */
export class SystemProxy {
  private resolvedAt = 0;

  constructor(
    private readonly core: ProxyCore,
    private readonly session: Pick<Session, 'resolveProxy'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves the system's proxy now, tells Core and answers it (`null`: direct). */
  async detect(): Promise<string | null> {
    this.resolvedAt = this.now();
    const url = proxyFromRules(await this.session.resolveProxy(PROBE_URL));
    this.core.setSystemProxy(url);
    return url;
  }

  /** A window came to the front: the network may have changed since. */
  focused(): void {
    if (this.now() - this.resolvedAt < FOCUS_INTERVAL_MS) return;
    this.detect().catch((error: unknown) => {
      console.warn('[proxy] resolving the system proxy failed', error);
    });
  }
}

/** `detectProxy`: the settings page shows what `auto` uses (no arguments). */
export function registerProxyHandlers(register: RegisterHandler, proxy: SystemProxy): void {
  register(IPC_CHANNELS.proxyDetect, () => proxy.detect());
}
