// The start page's data (design addendum B1.1.1, B4.2, B4.4, B4.5): what the main process
// answers for `startPage` and `suggest`, checked before the panel shows it, and the rows it
// derives from the session's live services. Pure, so it is tested without the DOM.

import type { DevServerState, LaunchConfigView, LaunchIssue } from '@piarc/protocol';

import type {
  BrowserRecent,
  BrowserServices,
  BrowserStartPage,
  BrowserSuggestion,
} from '../../shared/browser.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecent(value: unknown): value is BrowserRecent {
  return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string';
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isConfig(value: unknown): value is LaunchConfigView {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.source === 'piarc' || value.source === 'claude') &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.port === 'number' &&
    typeof value.url === 'string' &&
    typeof value.fingerprint === 'string'
  );
}

function isIssue(value: unknown): value is LaunchIssue {
  return isRecord(value) && typeof value.file === 'string' && typeof value.message === 'string';
}

/** The start page answer; malformed parts are dropped. */
export function parseStartPage(value: unknown): BrowserStartPage {
  if (!isRecord(value)) return { recents: [] };
  const recents = list(value.recents).filter(isRecent);
  const launch = value.launch;
  if (!isRecord(launch) || typeof launch.trusted !== 'boolean') return { recents };
  return {
    recents,
    launch: {
      configs: list(launch.configs).filter(isConfig),
      autoVerify: launch.autoVerify !== false,
      issues: list(launch.issues).filter(isIssue),
      trusted: launch.trusted,
    },
  };
}

/** The suggestions answer; malformed entries are dropped. */
export function parseSuggestions(value: unknown): BrowserSuggestion[] {
  return list(value).filter(
    (item): item is BrowserSuggestion =>
      isRecent(item) &&
      isRecord(item) &&
      (item.kind === 'history' || item.kind === 'tab' || item.kind === 'server'),
  );
}

/** Where an issue is: `file:line:column`, as far as it is known. */
export function issuePlace(issue: LaunchIssue): string {
  const line = issue.line === undefined ? '' : `:${String(issue.line)}`;
  const column =
    issue.line === undefined || issue.column === undefined ? '' : `:${String(issue.column)}`;
  return `${issue.file}${line}${column}`;
}

/** One local service of the start page: a ready server or a listening port. */
export interface ServiceRow {
  readonly port: number;
  readonly url: string;
  /** What runs it (the configuration's name, the command, the terminal). */
  readonly title: string;
}

/** The session's local services: ready servers first, then other listening ports. */
export function serviceRows(services: BrowserServices | undefined): ServiceRow[] {
  if (services === undefined) return [];
  const ready = services.servers.filter((server) => server.status === 'ready');
  const ports = new Set(ready.map((server) => server.port));
  return [
    ...ready.map((server) => ({ port: server.port, url: server.url, title: server.name })),
    ...services.ports
      .filter((port) => !ports.has(port.port))
      .map((port) => ({
        port: port.port,
        url: `http://localhost:${String(port.port)}/`,
        title: port.title,
      })),
  ];
}

/** A configuration with where its server stands in this session. */
export interface ServerRow {
  readonly config: LaunchConfigView;
  readonly state: DevServerState | undefined;
}

/** The configurations with the session's state of each. */
export function serverRows(
  configs: readonly LaunchConfigView[],
  services: BrowserServices | undefined,
): ServerRow[] {
  const states = new Map((services?.servers ?? []).map((state) => [state.name, state]));
  return configs.map((config) => ({ config, state: states.get(config.name) }));
}

/** Whether the server is running (starting or ready): the row offers Stop. */
export function running(state: DevServerState | undefined): boolean {
  return state?.status === 'starting' || state?.status === 'ready';
}

/** The failures the panel reports, without the ones the user dismissed. */
export function failures(
  services: BrowserServices | undefined,
  dismissed: ReadonlySet<string>,
): DevServerState[] {
  return (services?.servers ?? []).filter(
    (state) => state.status === 'failed' && !dismissed.has(failureKey(state)),
  );
}

/** Identifies one failure: the configuration and the task that failed. */
export function failureKey(state: DevServerState): string {
  return `${state.name}\u0000${state.taskId ?? ''}`;
}
