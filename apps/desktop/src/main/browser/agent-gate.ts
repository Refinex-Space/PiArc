// The request gate of the agent's pages (ADR-0089, design addendum B2.6.1–B2.6.4). Every
// request of a guest page passes the partition rules first (request-rules.ts); a page of a
// Space the agent controls then passes here, whatever its type (document, frame, script,
// image, fetch, WebSocket, beacon), so a script cannot carry data to a host by any route the
// user did not allow:
//
// - hosts the user allowed for the session, or for the running call ("allow once"), pass;
// - a local address passes when its port is the session's (B2.6.2): the user opened it in
//   their own tabs, a process tree of the session (background task, terminal, development
//   server) listens on it, or a launch configuration declares it (dev-servers.ts). PiArc's own
//   ports never get here: the partition rules refuse them first (request-rules.ts);
// - a document or frame of the running call that is not allowed asks Core, which may show a
//   site card (and waits for it); the answer also covers the hosts the run is waiting on;
// - anything else is refused and counted in the run's blocked hosts, which the model reads
//   in the call's result (and may ask for with `requestAccess`).
//
// The user's own pages, and an agent Space after the user took it over, are not gated here.

import type { BrowserSiteDecision } from '@piarc/protocol';

import type { RequestVerdict } from './request-rules.js';
import { loopbackHost, portOf } from './request-rules.js';

/** What the gate needs to know about a requesting page. */
export interface GatedPage {
  /** The main session whose Space holds the page. */
  readonly sessionId: string;
  readonly space: string;
  /** Whether the agent controls the Space now (`agent` ownership). */
  readonly agentControlled: boolean;
}

/** The run in progress on a Space. */
export interface GateRun {
  readonly callSessionId: string;
  readonly toolCallId: string;
  /** Hosts allowed for this run only. */
  readonly allowedHosts: Set<string>;
  /** Hosts the run was kept from reaching. */
  readonly blockedHosts: Set<string>;
}

export interface GateDeps {
  /** The page behind `webContentsId`; undefined for a page that is not a tab. */
  pageOf(webContentsId: number): GatedPage | undefined;
  /** Pages of agent-controlled Spaces showing `host`, for requests no page can be named for. */
  agentPagesOn(host: string): readonly GatedPage[];
  runFor(sessionId: string, space: string): GateRun | undefined;
  /**
   * Loopback ports of the session (B2.6.2): opened by the user in their own tabs, listened on
   * by the session's process trees, or declared by its launch configurations.
   */
  allowedPorts(sessionId: string): ReadonlySet<number>;
  /** Core's `browserSite`. */
  askCore(requestJson: string): Promise<string>;
  /** Local names the user treats as their machine (`*.test`, `*.local`, B5.5). */
  localNames(): readonly string[];
  /**
   * Whether `host` gets cookies imported from Chrome into the session's workspace (B5.4,
   * ADR-0090): such a host is sensitive like a private address. Core checks its records too.
   */
  importedHost?(sessionId: string, host: string): Promise<boolean>;
}

/** A request as the gate sees it (Electron's `onBeforeRequest` details). */
export interface GateRequest {
  readonly url: string;
  readonly resourceType: string;
  readonly webContentsId?: number;
  readonly referrer: string;
}

const ALLOW: RequestVerdict = { allow: true };
/** A refused request (the partition rules' reasons do not apply; `invalid` is closest). */
const REFUSE: RequestVerdict = { allow: false, reason: 'invalid' };
const NAVIGATIONS = new Set(['mainFrame', 'subFrame']);
const GATED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** Whether `host` is one of the user's local development names (`*.test`, `*.local`). */
export function localName(host: string, names: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return names.some((pattern) =>
    pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern.toLowerCase(),
  );
}

/** Whether `host` (a literal) is on a private network: no "always", every mode asks. */
export function privateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(name);
}

/** The key a grant uses: `host` for a site, `host:port` for a local address. */
export function hostKey(url: URL, names: readonly string[]): { key: string; local: boolean } {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = loopbackHost(host) || localName(host, names);
  return { key: local ? `${host}:${String(portOf(url))}` : host, local };
}

export class AgentGate {
  /** Hosts allowed for the session, by main session id. */
  readonly #session = new Map<string, Set<string>>();
  /** Questions to Core in flight, by call and host: one card per host at a time. */
  readonly #asking = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: GateDeps) {}

  /** The verdict on one request that passed the partition rules. */
  check(request: GateRequest): RequestVerdict | Promise<RequestVerdict> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return REFUSE;
    }
    if (!GATED_SCHEMES.has(url.protocol)) return ALLOW;
    const page =
      request.webContentsId === undefined ? undefined : this.deps.pageOf(request.webContentsId);
    if (page === undefined) return this.#unattributed(request, url);
    if (!page.agentControlled) return ALLOW;
    const { key, local } = hostKey(url, this.deps.localNames());
    const run = this.deps.runFor(page.sessionId, page.space);
    if (this.#allowed(page.sessionId, run, key, local, url)) return ALLOW;
    if (run === undefined || !NAVIGATIONS.has(request.resourceType)) {
      run?.blockedHosts.add(key);
      return REFUSE;
    }
    return this.#ask(page.sessionId, run, url, key, local).then((ok) => (ok ? ALLOW : REFUSE));
  }

  /**
   * `requestAccess(hosts, reason)` (B2.6.4): one card for hosts the run was kept from. Answers
   * whether they were allowed.
   */
  async requestAccess(sessionId: string, run: GateRun, hosts: readonly string[]): Promise<boolean> {
    const [first, ...rest] = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
    if (first === undefined) return false;
    const names = this.deps.localNames();
    let url: URL;
    try {
      url = new URL(`https://${first}/`);
    } catch {
      return false;
    }
    const { key, local } = hostKey(url, names);
    for (const host of rest) run.blockedHosts.add(host);
    return this.#ask(sessionId, run, url, key, local);
  }

  /** Forgets a session's grants (the session closed or was deleted). */
  forget(sessionId: string): void {
    this.#session.delete(sessionId);
  }

  #allowed(
    sessionId: string,
    run: GateRun | undefined,
    key: string,
    local: boolean,
    url: URL,
  ): boolean {
    if (this.#session.get(sessionId)?.has(key) === true) return true;
    if (run?.allowedHosts.has(key) === true) return true;
    return local && this.deps.allowedPorts(sessionId).has(portOf(url));
  }

  /** A request without a page (a service worker's): judged as the agent's when an agent
   * page shows the site it belongs to, without a card. */
  #unattributed(request: GateRequest, url: URL): RequestVerdict {
    let site: string;
    try {
      site = new URL(request.referrer).hostname.toLowerCase();
    } catch {
      return ALLOW;
    }
    const pages = this.deps.agentPagesOn(site).filter((page) => page.agentControlled);
    if (pages.length === 0) return ALLOW;
    const { key, local } = hostKey(url, this.deps.localNames());
    for (const page of pages) {
      const run = this.deps.runFor(page.sessionId, page.space);
      if (!this.#allowed(page.sessionId, run, key, local, url)) {
        run?.blockedHosts.add(key);
        return REFUSE;
      }
    }
    return ALLOW;
  }

  async #ask(
    sessionId: string,
    run: GateRun,
    url: URL,
    key: string,
    local: boolean,
  ): Promise<boolean> {
    const asking = `${run.toolCallId} ${key}`;
    let pending = this.#asking.get(asking);
    if (pending === undefined) {
      pending = this.#question(sessionId, run, url, key, local).finally(() => {
        this.#asking.delete(asking);
      });
      this.#asking.set(asking, pending);
    }
    return pending;
  }

  /** Whether `host` has imported sign-ins; an unreadable record counts as imported. */
  async #imported(sessionId: string, host: string): Promise<boolean> {
    if (this.deps.importedHost === undefined) return false;
    try {
      return await this.deps.importedHost(sessionId, host.replace(/^\[|\]$/g, '').toLowerCase());
    } catch (error) {
      console.warn('[browser] the imported sites could not be read', error);
      return true;
    }
  }

  async #question(
    sessionId: string,
    run: GateRun,
    url: URL,
    key: string,
    local: boolean,
  ): Promise<boolean> {
    const waiting = [...run.blockedHosts].filter((host) => host !== key);
    let decision: Pick<BrowserSiteDecision, 'allowed' | 'scope'>;
    try {
      const sensitive =
        privateHost(url.hostname) || (await this.#imported(sessionId, url.hostname));
      const answer: unknown = JSON.parse(
        await this.deps.askCore(
          JSON.stringify({
            sessionId: run.callSessionId,
            toolCallId: run.toolCallId,
            url: url.href,
            host: key,
            ...(local ? { local: true } : {}),
            ...(sensitive ? { sensitive: true } : {}),
            ...(waiting.length === 0 ? {} : { pending: waiting }),
          }),
        ),
      );
      if (typeof answer !== 'object' || answer === null) return false;
      decision = {
        allowed: 'allowed' in answer && answer.allowed === true,
        scope: 'scope' in answer && answer.scope === 'session' ? 'session' : 'run',
      };
    } catch (error) {
      console.warn('[browser] the site question failed', error);
      run.blockedHosts.add(key);
      return false;
    }
    if (!decision.allowed) {
      run.blockedHosts.add(key);
      return false;
    }
    const covered = [key, ...waiting];
    const target =
      decision.scope === 'session'
        ? (this.#session.get(sessionId) ?? new Set<string>())
        : run.allowedHosts;
    if (decision.scope === 'session') this.#session.set(sessionId, target);
    for (const host of covered) {
      target.add(host);
      run.blockedHosts.delete(host);
    }
    return true;
  }
}
