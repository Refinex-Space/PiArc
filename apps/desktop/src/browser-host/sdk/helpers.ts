// Ported from ego-browser package/ego-browser/src/helpers.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: only the v2 surface of PUBLIC_API_SCHEMA (profiles, listTaskSpaces, taskSpace,
// claimTaskSpace, takeOverTaskSpace, help) plus requestAccess (B2.6.4) and servers/startServer
// (ADR-0092). The frozen v1 helpers
// (global click/typeText/gotoUrl…, switchTaskSpace, newTaskSpace, useOrCreateTaskSpace,
// completeTaskSpace, handOffTaskSpace, waitForAgentControl, cdp/js, fetch helpers), the learning
// subsystem, agent_helpers.js and the egoBrowser stale-skill guard are not ported.

import type { BrowserServerInfo, BrowserServersResult } from '../../shared/browser-host.js';
import { isRecord } from './cdp-types.js';
import type { EgoBindings, EgoProfile } from './ego-bindings.js';
import { buildEgoError, invokeEgo } from './ego-errors.js';
import { formatHelp, help as helpRuntime } from './help-runtime.js';
import { bufferOutput } from './output-sink.js';
import {
  captureTaskSpaceUserBoundary,
  createTaskSpaceHandle,
  initializeTaskSpaceHandle,
  rollbackCreatedTaskSpace,
  type TaskSpaceDescriptor,
} from './page-model.js';
import { validatePublicApiOptions } from './public-api-schema.js';

type TaskSpace = ReturnType<typeof createTaskSpaceHandle>;

/** A task space as listed: the descriptor with ego's display fields filled in. */
type TaskSpaceEntry = TaskSpaceDescriptor & { taskId: string | number; name: string };

interface TaskSpaceResolution {
  descriptor: TaskSpaceEntry;
  created: boolean;
}

function bindings(op: string, method: keyof EgoBindings): EgoBindings {
  const ego = globalThis.ego;
  if (typeof ego?.[method] !== 'function') {
    throw new Error(`${op} requires ego.${method}`);
  }
  return ego;
}

/**
 * List Agent-owned and user-owned spaces.
 * Use the numeric id as the stable locator; display names may be duplicated.
 */
export async function listTaskSpaces(): Promise<TaskSpaceEntry[]> {
  const ego = bindings('listTaskSpaces', 'listTaskSpaces');
  return normalizeTaskSpaces(await invokeEgo('listTaskSpaces', () => ego.listTaskSpaces()));
}

/**
 * List browser profiles that may be selected when creating a task space.
 * Profile ids are stable locators; display names are not guaranteed unique.
 */
export async function profiles(): Promise<EgoProfile[]> {
  const ego = bindings('profiles', 'listProfiles');
  const result: unknown = await invokeEgo('profiles', () => ego.listProfiles());
  const list: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'profiles') : undefined;
  if (!Array.isArray(list) || !list.every(isProfile)) {
    throw new Error('profiles expected entries with id, name, and isDefault');
  }
  return list;
}

function isProfile(profile: unknown): profile is EgoProfile {
  if (typeof profile !== 'object' || profile === null) return false;
  const id: unknown = Reflect.get(profile, 'id');
  const name: unknown = Reflect.get(profile, 'name');
  const isDefault: unknown = Reflect.get(profile, 'isDefault');
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof name === 'string' &&
    typeof isDefault === 'boolean'
  );
}

/*
 * Task space ownership policy (`ownership`: "agent" | "agentDelegatedToUser" | "user").
 * "agent" and "agentDelegatedToUser" are both agent-owned (see isAgentOwned) — the
 * latter is the agent's own space with control temporarily handed to the user
 * (handoff or GUI takeover). The user-control boundary is enforced at the native
 * bridge when real commands run, not here. The rows below describe what each helper
 * does when the target space is user-owned:
 *
 *   taskSpace                 -> by name: throws EGO_TASK_SPACE_NAME_IN_USE;
 *                                by id: selects it unclaimed (user-control error surfaces)
 *   claimTaskSpace            -> claims it (ownership transfers to the agent), then selects it
 *   takeOverTaskSpace         -> no ownership check (operates as-is)
 */

/**
 * Whether the agent owns the space. "agentDelegatedToUser" is still agent-owned —
 * the agent created it but control is temporarily with the user (handoff / GUI
 * takeover). Selecting such a space is fine; the user-control boundary is enforced
 * separately at the native bridge when real commands run.
 */
function isAgentOwned(ownership: string | undefined): boolean {
  return ownership === 'agent' || ownership === 'agentDelegatedToUser';
}

async function createTaskSpaceResolution(
  name: string,
  profileId?: string,
  options: { select?: boolean } = {},
): Promise<TaskSpaceResolution> {
  const ego = bindings('newTaskSpace', 'createTaskSpace');
  // Do not pass an explicit undefined: native bindings reject extra arguments.
  const created = normalizeTaskSpace(
    await invokeEgo('newTaskSpace', () =>
      profileId === undefined ? ego.createTaskSpace(name) : ego.createTaskSpace(name, profileId),
    ),
  );
  if (!created) {
    throw new Error('newTaskSpace returned an invalid task space');
  }
  taskSpaceNumericId(created, 'newTaskSpace');
  // Creation through this Agent API is itself authoritative for ownership.
  const createdByAgent = {
    ...created,
    ownership: created.ownership ?? 'agent',
  };
  const descriptor =
    options.select === false
      ? createdByAgent
      : await selectTaskSpace(ego, createdByAgent, 'newTaskSpace');
  return {
    descriptor,
    created: true,
  };
}

async function resolveTaskSpace(
  nameOrId: string | number,
  options: { select?: boolean; op?: string } = {},
): Promise<TaskSpaceResolution> {
  const op = options.op ?? 'useOrCreateTaskSpace';
  const spaces = await listTaskSpaces();
  const existing = findMatchingTaskSpace(spaces, nameOrId);
  if (!existing) {
    if (typeof nameOrId === 'number') {
      throw new Error(`task space not found: ${String(nameOrId)}`);
    }
    return createTaskSpaceResolution(nameOrId, undefined, {
      ...(options.select === undefined ? {} : { select: options.select }),
    });
  }
  if (isAgentOwned(existing.ownership)) {
    return {
      descriptor:
        options.select === false
          ? existing
          : await selectTaskSpace(bindings(op, 'useTaskSpace'), existing, 'useOrCreateTaskSpace'),
      created: false,
    };
  }
  if (existing.ownership === 'user') {
    // A name match on a user-owned space is a name collision, not the agent's
    // task: the user is not "in control" of something the agent started. Report
    // it the way native createTaskSpace reports a duplicate name.
    if (typeof nameOrId === 'string' && existing.name === nameOrId) {
      throw buildEgoError(
        {
          error: [
            `A task space named ${JSON.stringify(nameOrId)} already exists and belongs to the user (id ${String(existing.id)}).`,
            `Do not take it over on your own. Ask the user whether to work in it; only if they agree, call claimTaskSpace(${String(existing.id)}).`,
            'Otherwise use a different task space name.',
          ].join('\n'),
          error_code: 'EGO_TASK_SPACE_NAME_IN_USE',
        },
        op,
      );
    }
    // Explicitly targeted by id: don't claim it here. Select it as-is; the user
    // stays in control, so EGO_TASK_SPACE_USER_IN_CONTROL surfaces (as
    // ego-browser's owned guidance, not the raw native text).
    return {
      descriptor:
        options.select === false
          ? existing
          : await selectTaskSpace(bindings(op, 'useTaskSpace'), existing, 'useOrCreateTaskSpace'),
      created: false,
    };
  }
  throw new Error(
    `useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`,
  );
}

/**
 * Return the v2 object handle for an existing task space, or create the space
 * when a string name does not exist.
 */
export async function taskSpace(
  nameOrId: unknown,
  options: { profileId?: string } = {},
): Promise<TaskSpace> {
  assertTaskSpaceLocator('taskSpace', nameOrId);
  validatePublicApiOptions('taskSpace', options);
  const { profileId } = options;
  if (profileId === undefined) {
    return initializeResolvedTaskSpace(
      await resolveTaskSpace(nameOrId, { select: false, op: 'taskSpace' }),
    );
  }
  if (typeof nameOrId !== 'string') {
    throw new TypeError('taskSpace profileId can only be used with a new task-space name');
  }
  const existing = findMatchingTaskSpace(await listTaskSpaces(), nameOrId);
  if (existing) {
    throw new Error(
      `taskSpace profileId only applies when creating a new task space; ${JSON.stringify(nameOrId)} already exists`,
    );
  }
  return initializeResolvedTaskSpace(
    await createTaskSpaceResolution(nameOrId, profileId, { select: false }),
  );
}

async function initializeResolvedTaskSpace(resolution: TaskSpaceResolution): Promise<TaskSpace> {
  const task = createTaskSpaceHandle(resolution.descriptor);
  if (!resolution.created) {
    await initializeTaskSpaceHandle(task);
    return task;
  }

  try {
    await initializeTaskSpaceHandle(task, { created: true });
    return task;
  } catch (error) {
    // A fresh space must not survive without its canonical p1 ledger entry.
    // Preserve the initialization error if native rollback is unavailable.
    await rollbackCreatedTaskSpace(task).catch(() => undefined);
    throw error;
  }
}

/**
 * Claim a user-owned task space (ownership transfers to the agent) and select it.
 * Resolves the space by id/name, claims it via ego.claimTaskSpace, then selects it.
 */
export async function claimTaskSpace(nameOrId: unknown): Promise<TaskSpace> {
  const space = await findTaskSpace(nameOrId, 'claimTaskSpace');
  const claimed = await claimResolvedTaskSpace(space, 'claimTaskSpace');
  const task = createTaskSpaceHandle({ ...claimed, ownership: 'agent' });
  await captureTaskSpaceUserBoundary(task);
  await initializeTaskSpaceHandle(task);
  return task;
}

async function claimResolvedTaskSpace(
  space: TaskSpaceEntry,
  op = 'claimTaskSpace',
): Promise<TaskSpaceEntry> {
  const ego = bindings(op, 'claimTaskSpace');
  const id = taskSpaceNumericId(space, op);
  const claimed = normalizeTaskSpace(
    // An empty name would rename the Space while claiming it; omit it so an
    // unnamed user Space keeps its UI placeholder.
    await invokeEgo(op, () =>
      space.name ? ego.claimTaskSpace(id, space.name) : ego.claimTaskSpace(id),
    ),
  );
  if (!claimed) {
    throw new Error(`${op} returned an invalid task space`);
  }
  taskSpaceNumericId(claimed, op);
  return selectTaskSpace(ego, claimed, op);
}

async function selectTaskSpace<T extends TaskSpaceEntry>(
  ego: EgoBindings,
  space: T,
  op: string,
): Promise<T> {
  if (typeof ego.useTaskSpace !== 'function') {
    throw new Error(`${op} requires ego.useTaskSpace`);
  }
  await invokeEgo(op, () => ego.useTaskSpace(taskSpaceNumericId(space, op)));
  return space;
}

/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * Answers a TaskSpace when a name or id is provided; otherwise preserves the
 * selected-space form's void result.
 */
export async function takeOverTaskSpace(nameOrId?: unknown): Promise<TaskSpace | undefined> {
  const ego = bindings('takeOverTaskSpace', 'takeOverTaskSpace');
  let descriptor: TaskSpaceEntry | undefined;
  if (nameOrId !== undefined) {
    descriptor = await findTaskSpace(nameOrId, 'takeOverTaskSpace');
    await selectTaskSpace(ego, descriptor, 'takeOverTaskSpace');
  }
  await invokeEgo('takeOverTaskSpace', () => ego.takeOverTaskSpace());
  if (descriptor) {
    const task = createTaskSpaceHandle({ ...descriptor, ownership: 'agent' });
    // Repeatedly ensuring control over an already agent-controlled space is a
    // no-op, not a user interaction boundary. Only delegated spaces can have
    // gained tabs through user activity since the Agent last controlled them.
    if (descriptor.ownership === 'agentDelegatedToUser') {
      await captureTaskSpaceUserBoundary(task);
    }
    await initializeTaskSpaceHandle(task);
    return task;
  }
  return undefined;
}

/**
 * PiArc (B2.6.4): ask the user to let this run reach hosts the site gate blocked.
 * Resolves true when the user allowed them.
 */
export async function requestAccess(hosts: unknown, reason: unknown): Promise<boolean> {
  const list: unknown = typeof hosts === 'string' ? [hosts] : hosts;
  if (!isHostList(list)) {
    throw new TypeError('requestAccess expects a host name or a non-empty array of host names');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('requestAccess expects a non-empty reason the user will read');
  }
  const ego = bindings('requestAccess', 'requestAccess');
  return invokeEgo('requestAccess', () => ego.requestAccess(list, reason));
}

/**
 * PiArc (ADR-0092): the project's launch configurations with their state in this session, the
 * TCP ports the session's processes listen on, and problems of the launch files.
 */
export async function servers(): Promise<BrowserServersResult> {
  const ego = bindings('servers', 'servers');
  return invokeEgo('servers', () => ego.servers());
}

/**
 * PiArc (ADR-0092): start launch configuration `name` and wait until its port answers or it
 * fails. The first start of a configuration in a session asks the user; it runs outside the
 * sandbox. A running one resolves at once.
 */
export async function startServer(name: unknown): Promise<BrowserServerInfo> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('startServer expects the name of a launch configuration from servers()');
  }
  const ego = bindings('startServer', 'startServer');
  return invokeEgo('startServer', () => ego.startServer(name));
}

function isHostList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((host) => typeof host === 'string' && host.trim() !== '')
  );
}

function normalizeTaskSpaces(raw: unknown): TaskSpaceEntry[] {
  const list: unknown =
    typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'taskSpaces') : undefined;
  if (Array.isArray(list)) {
    return list.map(normalizeTaskSpace).filter((space) => space !== null);
  }
  throw new Error('listTaskSpaces expected { taskSpaces: [...] }');
}

// `id` is the native locator. `name` and `taskId` are display values and are
// empty for a user Space that was never renamed, so they must not gate entries.
// PiArc: the bindings pass only entries with a numeric id (bindings.ts checks every
// answer), so an entry without one is dropped here as upstream drops a missing id.
function normalizeTaskSpace(space: unknown): TaskSpaceEntry | null {
  if (!isRecord(space) || typeof space.id !== 'number') {
    return null;
  }
  const taskId =
    typeof space.taskId === 'string' || typeof space.taskId === 'number' ? space.taskId : undefined;
  const name =
    typeof space.name === 'string' ? space.name : taskId === undefined ? '' : String(taskId);
  // Like upstream, every other field the binding reported stays on the entry the
  // script sees; the fields the Page model reads are kept only with their types.
  const { createdBy, ownership, recentTabTitles, ...rest } = space;
  return {
    ...rest,
    id: space.id,
    taskId: taskId ?? name,
    name,
    ...(typeof createdBy === 'string' ? { createdBy } : {}),
    ...(typeof ownership === 'string' ? { ownership } : {}),
    ...(isStringArray(recentTabTitles) ? { recentTabTitles } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function taskSpaceNumericId(space: TaskSpaceEntry, op: string): number {
  const id: unknown = space.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error(`${op} requires a numeric task space id, got ${JSON.stringify(id)}`);
  }
  return id;
}

async function findTaskSpace(nameOrId: unknown, op: string): Promise<TaskSpaceEntry> {
  assertTaskSpaceLocator(op, nameOrId);
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) throw new Error(`task space not found: ${String(nameOrId)}`);
  return match;
}

// Reject bad locators before any native call: an unmatched string name falls
// through to creating a space, so undefined must never reach that branch.
function assertTaskSpaceLocator(
  op: string,
  nameOrId: unknown,
): asserts nameOrId is string | number {
  if (typeof nameOrId === 'number' && Number.isSafeInteger(nameOrId)) return;
  if (typeof nameOrId === 'string' && nameOrId.trim() !== '') return;
  throw new TypeError(
    `${op} expects a task-space name (non-empty string) or numeric id, got ${describeLocator(nameOrId)}. ` +
      `listTaskSpaces() entries expose the numeric id as "id"; pass entry.id.`,
  );
}

function describeLocator(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || value === null || value === undefined) return String(value);
  return typeof value;
}

function findMatchingTaskSpace(
  spaces: TaskSpaceEntry[],
  nameOrId: string | number,
): TaskSpaceEntry | undefined {
  if (typeof nameOrId === 'number') {
    return spaces.find((space) => space.id === nameOrId);
  }
  const byName = spaces.find((space) => space.name === nameOrId || space.taskId === nameOrId);
  if (byName) return byName;
  if (/^\d+$/.test(nameOrId)) {
    const id = Number(nameOrId);
    if (Number.isFinite(id)) {
      return spaces.find((space) => space.id === id);
    }
  }
  return undefined;
}

/** The helpers a script sees, by name. */
export type HelperContext = Record<string, unknown>;

export function helperContext({
  printHelp = (text: string) => {
    bufferOutput(`${text}\n`);
  },
}: { printHelp?: (text: string) => void } = {}): HelperContext {
  return {
    profiles,
    listTaskSpaces,
    taskSpace,
    claimTaskSpace,
    takeOverTaskSpace,
    requestAccess,
    servers,
    startServer,
    // help() prints its text and still returns it for scripts that log or inspect it.
    help: (...names: unknown[]) => {
      const result = helpRuntime(...names.map(String));
      const text =
        typeof result === 'string'
          ? result
          : Array.isArray(result)
            ? result.map(formatHelp).join('\n\n')
            : formatHelp(result);
      printHelp(text);
      return text;
    },
  };
}
