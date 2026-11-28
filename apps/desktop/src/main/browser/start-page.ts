// The start page's requests (design addendum B1.1.1, B1.2.3, B4.2): recent pages and launch
// configurations, running and stopping a configuration for the user (Core runs it as a
// background task; a user's click is not asked about), and the address bar's suggestions.
// Core answers in JSON; every answer is checked before the panel sees it.

import type { DevServerState, LaunchConfigView, LaunchView } from '@piarc/protocol';

import {
  BROWSER_LIMITS,
  type BrowserRecent,
  type BrowserStartPage,
  type BrowserSuggestion,
} from '../../shared/browser.js';
import type { BrowserServerInfo, BrowserServersResult } from '../../shared/browser-host.js';
import {
  parseLaunchView,
  parseServerState,
  type DevServers,
  type SessionServices,
} from './dev-servers.js';
import type { BrowserRecents } from './recents.js';
import { rankSuggestions } from './suggestions.js';

/** Core's NAPI calls of the start page (ADR-0092). */
export interface StartPageCore {
  launchConfigs(sessionId: string): Promise<string>;
  startDevServer(requestJson: string): Promise<string>;
  stopDevServer(sessionId: string, name: string): Promise<string>;
}

/** A server's state from Core's JSON answer. */
export function serverAnswer(json: string): DevServerState {
  const state = parseServerState(JSON.parse(json));
  if (state === undefined) throw new Error('Core answered an invalid server state');
  return state;
}

/** The local services of a session as addresses: ready servers, then listening ports. */
export function serviceAddresses(devServers: DevServers, sessionId: string): BrowserRecent[] {
  const { ports, servers } = devServers.services(sessionId);
  const ready = servers.filter((server) => server.status === 'ready');
  const listed = new Set(ready.map((server) => server.port));
  return [
    ...ready.map((server) => ({ url: server.url, title: server.name })),
    ...ports
      .filter((port) => !listed.has(port.port))
      .map((port) => ({ url: `http://localhost:${String(port.port)}/`, title: port.title })),
  ];
}

/** A server as the agent's `servers()` and `startServer()` report it (ADR-0092). */
export function serverInfo(
  config: LaunchConfigView | undefined,
  state: DevServerState | undefined,
  name: string,
): BrowserServerInfo {
  return {
    name,
    status: state?.status ?? 'idle',
    url: state?.url ?? config?.url ?? '',
    port: state?.port ?? config?.port ?? 0,
    ...(config === undefined
      ? {}
      : { command: config.command, cwd: config.cwd, source: config.source }),
    ...(state === undefined ? {} : { startedBy: state.startedBy }),
    ...(state?.failure == null ? {} : { failure: state.failure }),
    ...(state?.exitCode == null ? {} : { exitCode: state.exitCode }),
    ...(state?.log === undefined ? {} : { log: state.log }),
  };
}

/** What the agent's `servers()` answers: configurations with their state, listening ports. */
export function serversResult(launch: LaunchView, services: SessionServices): BrowserServersResult {
  const states = new Map(
    [...(launch.servers ?? []), ...services.servers].map((state) => [state.name, state]),
  );
  return {
    trusted: launch.trusted,
    servers: launch.configs.map((config) =>
      serverInfo(config, states.get(config.name), config.name),
    ),
    listening: services.ports.map((port) => ({
      port: port.port,
      url: `http://localhost:${String(port.port)}/`,
      title: port.title,
      kind: port.kind,
    })),
    problems: (launch.issues ?? []).map(
      (issue) =>
        `${issue.file}${issue.line === undefined ? '' : `:${String(issue.line)}`}${
          issue.column === undefined ? '' : `:${String(issue.column)}`
        } ${issue.message}`,
    ),
  };
}

export class StartPage {
  constructor(
    private readonly core: StartPageCore,
    private readonly recents: BrowserRecents,
    private readonly devServers: DevServers,
  ) {}

  /** What the start page of `sessionId` lists besides the live services. */
  async page(sessionId: string, workspace: string): Promise<BrowserStartPage> {
    const recents = await this.recents.list(workspace, BROWSER_LIMITS.recents);
    try {
      const launch = parseLaunchView(JSON.parse(await this.core.launchConfigs(sessionId)));
      return launch === undefined ? { recents } : { recents, launch };
    } catch (error) {
      console.warn('[browser] cannot read the launch configurations', error);
      return { recents };
    }
  }

  /** The user runs configuration `name` (B4.2: no approval for a click). */
  async start(sessionId: string, name: string): Promise<DevServerState> {
    return serverAnswer(await this.core.startDevServer(JSON.stringify({ sessionId, name })));
  }

  /** The user stops configuration `name`: its whole process tree ends. */
  async stop(sessionId: string, name: string): Promise<DevServerState> {
    return serverAnswer(await this.core.stopDevServer(sessionId, name));
  }

  /** The address bar's suggestions for `input` (B1.2.3). */
  async suggest(
    sessionId: string,
    workspace: string,
    input: string,
    tabs: readonly BrowserRecent[],
  ): Promise<BrowserSuggestion[]> {
    const history = await this.recents.list(workspace, Number.MAX_SAFE_INTEGER);
    return rankSuggestions(
      input,
      { history, tabs, services: serviceAddresses(this.devServers, sessionId) },
      BROWSER_LIMITS.suggestions,
    );
  }
}
