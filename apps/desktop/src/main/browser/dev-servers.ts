// What Core reports of a session's development servers and listening ports (ADR-0092, design
// addendum B2.6.2, B4.2–B4.5): the `ports` and `servers` events of `core/browser`, kept per main
// session. The agent's request gate lets its pages reach the ports listed here (listening in
// the session's process trees, or declared by a launch configuration); the panel lists them on
// the start page; a port that starts listening is announced once per session, and a server
// that fails is reported once per failure. Core decides all of it; this only keeps the latest
// snapshot and checks its shape.

import type {
  DevServerFailure,
  DevServerStarter,
  DevServerState,
  DevServerStatus,
  LaunchConfigView,
  LaunchIssue,
  LaunchSource,
  LaunchView,
  ListeningPort,
  TaskKind,
} from '@piarc/protocol';

/** What the panel shows of a session's services. */
export interface SessionServices {
  readonly ports: readonly ListeningPort[];
  readonly declared: readonly number[];
  readonly servers: readonly DevServerState[];
}

/** Who hears about changes. */
export interface DevServerEvents {
  /** The session's ports or servers changed. */
  changed(sessionId: string): void;
  /** `port` listens in the session for the first time since PiArc started. */
  announce(sessionId: string, port: number): void;
  /** A server of the session failed (exited or did not become ready). */
  failed(sessionId: string, server: DevServerState): void;
}

interface Entry {
  workspace: string;
  ports: readonly ListeningPort[];
  declared: readonly number[];
  servers: readonly DevServerState[];
  /** Ports announced in this session; a port that goes away and comes back is not again. */
  readonly announced: Set<number>;
}

const EMPTY: SessionServices = { ports: [], declared: [], servers: [] };
const KINDS: readonly TaskKind[] = ['command', 'subagent', 'monitor', 'terminal', 'devServer'];
const STATUSES: readonly DevServerStatus[] = ['starting', 'ready', 'failed', 'stopped'];
const STARTERS: readonly DevServerStarter[] = ['user', 'agent'];
const FAILURES: readonly DevServerFailure[] = ['exited', 'timeout', 'spawn'];
const SOURCES: readonly LaunchSource[] = ['piarc', 'claude'];
/** Lines of a failed server's log the panel shows (B4.5). */
export const FAILURE_LOG_LINES = 20;

export class DevServers {
  readonly #sessions = new Map<string, Entry>();

  constructor(private readonly events: DevServerEvents) {}

  /** A `ports` event: the complete list for the session. */
  ports(
    sessionId: string,
    workspace: string,
    ports: readonly ListeningPort[],
    declared: readonly number[],
  ): void {
    const entry = this.#entry(sessionId, workspace);
    entry.ports = [...ports].sort((a, b) => a.port - b.port);
    entry.declared = [...new Set(declared)].sort((a, b) => a - b);
    const fresh = entry.ports.map((p) => p.port).filter((port) => !entry.announced.has(port));
    for (const port of fresh) entry.announced.add(port);
    this.events.changed(sessionId);
    for (const port of new Set(fresh)) this.events.announce(sessionId, port);
  }

  /** A `servers` event: the complete list for the session. */
  servers(sessionId: string, workspace: string, servers: readonly DevServerState[]): void {
    const entry = this.#entry(sessionId, workspace);
    const before = new Map(entry.servers.map((s) => [s.name, s]));
    entry.servers = servers;
    this.events.changed(sessionId);
    for (const server of servers) {
      const previous = before.get(server.name);
      const newly =
        server.status === 'failed' &&
        (previous?.status !== 'failed' || previous.taskId !== server.taskId);
      if (newly) this.events.failed(sessionId, server);
    }
  }

  /** Ports the agent's pages of the session may reach: listening or declared (B2.6.2). */
  allowedPorts(sessionId: string): ReadonlySet<number> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return new Set();
    return new Set([...entry.ports.map((p) => p.port), ...entry.declared]);
  }

  /** The session's latest snapshot. */
  services(sessionId: string): SessionServices {
    const entry = this.#sessions.get(sessionId);
    return entry === undefined
      ? EMPTY
      : { ports: entry.ports, declared: entry.declared, servers: entry.servers };
  }

  /** The session was deleted. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #entry(sessionId: string, workspace: string): Entry {
    let entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      entry = { workspace, ports: [], declared: [], servers: [], announced: new Set() };
      this.#sessions.set(sessionId, entry);
    }
    entry.workspace = workspace;
    return entry;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: readonly unknown[] = value;
  return list.every((item) => typeof item === 'string') ? list.map(String) : undefined;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.some((item) => item === value);
}

/** One listening port of a `ports` event, or undefined when malformed. */
export function parseListeningPort(value: unknown): ListeningPort | undefined {
  if (
    !isRecord(value) ||
    !isPort(value.port) ||
    typeof value.taskId !== 'string' ||
    !oneOf(KINDS, value.kind) ||
    typeof value.title !== 'string'
  ) {
    return undefined;
  }
  return { port: value.port, taskId: value.taskId, kind: value.kind, title: value.title };
}

/** A server's state as Core reports it, or undefined when malformed. */
export function parseServerState(value: unknown): DevServerState | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !oneOf(STATUSES, value.status) ||
    !oneOf(STARTERS, value.startedBy) ||
    !isPort(value.port) ||
    typeof value.url !== 'string'
  ) {
    return undefined;
  }
  const log = value.log === undefined ? [] : strings(value.log);
  if (log === undefined) return undefined;
  const failure = value.failure;
  if (failure !== undefined && !oneOf(FAILURES, failure)) return undefined;
  const exitCode = value.exitCode;
  if (exitCode !== undefined && !(typeof exitCode === 'number' && Number.isInteger(exitCode))) {
    return undefined;
  }
  if (value.taskId !== undefined && typeof value.taskId !== 'string') return undefined;
  return {
    name: value.name,
    status: value.status,
    startedBy: value.startedBy,
    port: value.port,
    url: value.url,
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    ...(failure === undefined ? {} : { failure }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(log.length === 0 ? {} : { log: log.slice(-FAILURE_LOG_LINES) }),
  };
}

function parseConfig(value: unknown): LaunchConfigView | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !oneOf(SOURCES, value.source) ||
    typeof value.command !== 'string' ||
    typeof value.cwd !== 'string' ||
    !isPort(value.port) ||
    typeof value.url !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    (value.autoPort !== undefined && typeof value.autoPort !== 'boolean')
  ) {
    return undefined;
  }
  return {
    name: value.name,
    source: value.source,
    command: value.command,
    cwd: value.cwd,
    port: value.port,
    url: value.url,
    fingerprint: value.fingerprint,
    ...(value.autoPort === true ? { autoPort: true } : {}),
  };
}

function parseIssue(value: unknown): LaunchIssue | undefined {
  if (!isRecord(value) || typeof value.file !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }
  const place = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null);
  const line = place(value.line);
  const column = place(value.column);
  return {
    file: value.file,
    message: value.message,
    ...(line === null ? {} : { line }),
    ...(column === null ? {} : { column }),
  };
}

/** Each item parsed, or undefined when any is malformed (or the value is not a list). */
function listOf<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const list: readonly unknown[] = value;
  const items: T[] = [];
  for (const item of list) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    items.push(parsed);
  }
  return items;
}

/** `launchConfigs`' answer, or undefined when malformed. */
export function parseLaunchView(value: unknown): LaunchView | undefined {
  if (!isRecord(value) || typeof value.autoVerify !== 'boolean') return undefined;
  if (typeof value.trusted !== 'boolean') return undefined;
  const configs = listOf(value.configs, parseConfig);
  const issues = listOf(value.issues, parseIssue);
  const servers = listOf(value.servers, parseServerState);
  if (configs === undefined || issues === undefined || servers === undefined) return undefined;
  return { configs, autoVerify: value.autoVerify, issues, trusted: value.trusted, servers };
}

/** The `ports` list of an event, or undefined when malformed. */
export function parsePorts(value: unknown): ListeningPort[] | undefined {
  return value === undefined ? undefined : listOf(value, parseListeningPort);
}

/** The `declared` list of an event, or undefined when malformed. */
export function parseDeclared(value: unknown): number[] | undefined {
  return listOf(value, (item) => (isPort(item) ? item : undefined));
}

/** The `servers` list of an event, or undefined when malformed. */
export function parseServers(value: unknown): DevServerState[] | undefined {
  return value === undefined ? undefined : listOf(value, parseServerState);
}
