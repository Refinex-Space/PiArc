// The workspace's MCP configuration as Core answers `mcp/servers` (T36): checked at the
// boundary before the pool uses it.
import type {
  McpAvailability,
  McpConfigIssue,
  McpHttp,
  McpOAuth,
  McpOverridden,
  McpScope,
  McpServerDefinition,
  McpServersResult,
  McpStdio,
  McpTransport,
} from '@piarc/protocol';

import { isObject } from '../runtime/items.js';

const SCOPES: readonly McpScope[] = [
  'enterprise',
  'local',
  'project',
  'user',
  'plugin',
  'subagent',
];
const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse', 'ws'];
const AVAILABILITY: readonly McpAvailability[] = ['ready', 'disabled', 'unsupported', 'untrusted'];

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((v) => v === value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}

function stdio(value: unknown): McpStdio | undefined {
  if (!isObject(value) || typeof value.command !== 'string') return undefined;
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
    return undefined;
  }
  const env = strings(value.env);
  if (env === undefined) return undefined;
  const cwd = optionalString(value.cwd);
  return { command: value.command, args, env, ...(cwd === undefined ? {} : { cwd }) };
}

function oauth(value: unknown): McpOAuth | undefined {
  if (!isObject(value)) return undefined;
  const port = value.callbackPort;
  return {
    ...(typeof value.clientId === 'string' ? { clientId: value.clientId } : {}),
    ...(typeof port === 'number' && Number.isInteger(port) ? { callbackPort: port } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(typeof value.authServerMetadataUrl === 'string'
      ? { authServerMetadataUrl: value.authServerMetadataUrl }
      : {}),
  };
}

function http(value: unknown): McpHttp | undefined {
  if (!isObject(value) || typeof value.url !== 'string') return undefined;
  const headers = strings(value.headers);
  if (headers === undefined) return undefined;
  const settings = value.oauth == null ? undefined : oauth(value.oauth);
  return { url: value.url, headers, ...(settings === undefined ? {} : { oauth: settings }) };
}

/** One definition, or undefined when it is malformed. */
export function parseDefinition(value: unknown): McpServerDefinition | undefined {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.source !== 'string') {
    return undefined;
  }
  const scope = oneOf(SCOPES, value.scope);
  const transport = oneOf(TRANSPORTS, value.transport);
  const availability = oneOf(AVAILABILITY, value.availability);
  if (scope === undefined || transport === undefined || availability === undefined) {
    return undefined;
  }
  const program = value.stdio == null ? undefined : stdio(value.stdio);
  const endpoint = value.http == null ? undefined : http(value.http);
  if (
    (value.stdio != null && program === undefined) ||
    (value.http != null && endpoint === undefined)
  ) {
    return undefined;
  }
  const timeout = value.timeoutMs;
  return {
    name: value.name,
    scope,
    source: value.source,
    transport,
    availability,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(program === undefined ? {} : { stdio: program }),
    ...(endpoint === undefined ? {} : { http: endpoint }),
    ...(typeof timeout === 'number' && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(value.alwaysLoad === true ? { alwaysLoad: true } : {}),
  };
}

function issues(value: unknown): McpConfigIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) =>
    isObject(issue) &&
    typeof issue.source === 'string' &&
    typeof issue.pointer === 'string' &&
    typeof issue.message === 'string'
      ? [{ source: issue.source, pointer: issue.pointer, message: issue.message }]
      : [],
  );
}

function overridden(value: unknown): McpOverridden[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isObject(entry) &&
    typeof entry.name === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.by === 'string'
      ? [{ name: entry.name, source: entry.source, by: entry.by }]
      : [],
  );
}

/** Core's answer to `mcp/servers`, or undefined when it is malformed. */
export function parseServers(value: unknown): McpServersResult | undefined {
  if (!isObject(value) || !Array.isArray(value.servers)) return undefined;
  const servers: McpServerDefinition[] = [];
  for (const entry of value.servers) {
    const def = parseDefinition(entry);
    if (def === undefined) return undefined;
    servers.push(def);
  }
  const env = strings(value.env);
  const idle = value.idleTimeoutMs;
  const threshold = value.deferThreshold;
  if (env === undefined || typeof idle !== 'number' || typeof threshold !== 'number') {
    return undefined;
  }
  return {
    servers,
    env,
    idleTimeoutMs: idle,
    deferThreshold: threshold,
    overridden: overridden(value.overridden),
    issues: issues(value.issues),
  };
}

/** A definition's identity: what decides whether a running connection still matches it. */
export function definitionKey(def: McpServerDefinition): string {
  return JSON.stringify([
    def.transport,
    def.stdio ?? null,
    def.http ?? null,
    def.timeoutMs ?? null,
  ]);
}

/** HTTP servers sign in with OAuth unless they send their own `Authorization` header. */
export function usesOAuth(def: McpServerDefinition): boolean {
  return (
    def.http != null &&
    !Object.keys(def.http.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
  );
}
