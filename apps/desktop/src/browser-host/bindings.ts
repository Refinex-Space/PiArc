// The `globalThis.ego` object the ported SDK calls (sdk/ego-bindings.ts), built on the script
// host's preload API `window.piarcBrowserHost` (src/shared/browser-host.ts, ADR-0091). Ego Lite's
// native bindings act on a task space selected with `useTaskSpace`; here that selection is local
// state and every request names its Space. Answers cross IPC, so each one is checked before the
// SDK sees it; a failure keeps ego's shapes: most bindings resolve `{ error, error_code }`,
// `snapshot` rejects with an Error carrying `error_code`, a CDP send failure goes to
// `onSendCDPMessageError`, and an invalid argument throws a TypeError.

import type {
  BrowserHostApi,
  BrowserHostFailure,
  BrowserHostRequest,
  SnapshotOptions,
  SnapshotResult,
  SnapshotRef,
  TabInfo,
  TaskSpaceInfo,
} from '../shared/browser-host.js';
import { isRecord } from './sdk/cdp-types.js';
import type {
  EgoBindings,
  EgoErrorResult,
  EgoProfile,
  EgoResult,
  EgoSnapshotOptions,
} from './sdk/ego-bindings.js';

export interface BindingsOptions {
  /** The Space selected before the script selects one (`BrowserHostRun.defaultSpace`). */
  readonly defaultSpace?: number;
}

type ErrorWithCode = Error & { error_code?: string };

const NOT_SELECTED: EgoErrorResult = {
  error: 'Task space not selected',
  error_code: 'EGO_TASK_SPACE_NOT_SELECTED',
};

/** Builds the ego-compatible bindings over the host API; registers the CDP listener once. */
export function createEgoBindings(api: BrowserHostApi, options: BindingsOptions = {}): EgoBindings {
  let selected = options.defaultSpace;

  /**
   * Sends one request; a failure answer or a rejection becomes an ego error object. A rejection
   * keeps its code when it carries one (the snapshot op rejects with a `BrowserHostFailure`).
   */
  async function request(message: BrowserHostRequest): Promise<{ ok: unknown } | EgoErrorResult> {
    let answer: unknown;
    try {
      answer = await api.call(message);
    } catch (error) {
      if (isFailure(error)) return egoError(error);
      const code: unknown = error instanceof Error ? Reflect.get(error, 'error_code') : undefined;
      return {
        error: error instanceof Error ? error.message : String(error),
        error_code: typeof code === 'string' && code ? code : 'EGO_OPERATION_FAILED',
      };
    }
    return isFailure(answer) ? egoError(answer) : { ok: answer };
  }

  /** Runs a task-scoped request for the selected Space and checks its answer. */
  async function scoped<T>(
    op: string,
    build: (space: number) => BrowserHostRequest,
    parse: (value: unknown) => T | undefined,
  ): Promise<EgoResult<T>> {
    if (selected === undefined) return NOT_SELECTED;
    return checked(op, await request(build(selected)), parse);
  }

  async function activeTargetId(space: number): Promise<string | EgoErrorResult> {
    const tabs = checked('listTabs', await request({ op: 'listTabs', space }), parseTabs);
    if ('error' in tabs) return tabs;
    const active = tabs.tabs.find((tab) => tab.active) ?? tabs.tabs[tabs.tabs.length - 1];
    return active
      ? active.targetId
      : { error: 'The task space has no tab', error_code: 'EGO_OPERATION_FAILED' };
  }

  const bindings: EgoBindings = {
    onCDPMessage: undefined,
    onSendCDPMessageError: undefined,

    async listProfiles() {
      return checked('listProfiles', await request({ op: 'listProfiles' }), parseProfiles);
    },

    async listTaskSpaces() {
      return checked('listTaskSpaces', await request({ op: 'listTaskSpaces' }), parseTaskSpaces);
    },

    async createTaskSpace(name: string, profileId?: string) {
      requireArgument(typeof name === 'string' && name.length > 0, 'createTaskSpace', 'name');
      requireArgument(
        profileId === undefined || typeof profileId === 'string',
        'createTaskSpace',
        'profileId',
      );
      // PiArc has one browser profile per workspace; ego's "default" locators select it.
      if (profileId !== undefined && profileId !== '' && profileId !== 'default') {
        return { error: 'Profile not found', error_code: 'EGO_PROFILE_NOT_FOUND' };
      }
      return checked(
        'createTaskSpace',
        await request({ op: 'createTaskSpace', name }),
        parseTaskSpace,
      );
    },

    async claimTaskSpace(id: number, name?: string) {
      requireArgument(typeof id === 'number', 'claimTaskSpace', 'id');
      requireArgument(name === undefined || typeof name === 'string', 'claimTaskSpace', 'name');
      return checked(
        'claimTaskSpace',
        await request({ op: 'claimTaskSpace', id, ...(name === undefined ? {} : { name }) }),
        parseTaskSpace,
      );
    },

    useTaskSpace(id: number) {
      requireArgument(typeof id === 'number' && Number.isFinite(id), 'useTaskSpace', 'id');
      selected = id;
      return id;
    },

    closeTaskSpace() {
      return scoped('closeTaskSpace', (space) => ({ op: 'closeTaskSpace', space }), parseStatus);
    },

    completeTaskSpace() {
      return scoped(
        'completeTaskSpace',
        (space) => ({ op: 'completeTaskSpace', space }),
        parseStatus,
      );
    },

    handOffTaskSpace() {
      return scoped(
        'handOffTaskSpace',
        (space) => ({ op: 'handOffTaskSpace', space }),
        parseStatus,
      );
    },

    takeOverTaskSpace() {
      return scoped(
        'takeOverTaskSpace',
        (space) => ({ op: 'takeOverTaskSpace', space }),
        parseStatus,
      );
    },

    setAgentTaskState(taskState: string) {
      requireArgument(typeof taskState === 'string', 'setAgentTaskState', 'state');
      return scoped(
        'setAgentTaskState',
        (space) => ({ op: 'setAgentTaskState', space, state: taskState }),
        parseStatus,
      );
    },

    async animationHighlightMouseToPosition(x: number, y: number, targetId?: string) {
      requireArgument(typeof x === 'number' && typeof y === 'number', 'highlight', 'x, y');
      const space = selected;
      if (space === undefined) return NOT_SELECTED;
      const target = targetId ?? (await activeTargetId(space));
      if (typeof target !== 'string') return target;
      return checked(
        'highlight',
        await request({ op: 'highlight', space, targetId: target, x, y }),
        parseStatus,
      );
    },

    createTab(url: string) {
      requireArgument(typeof url === 'string', 'createTab', 'url');
      return scoped('createTab', (space) => ({ op: 'createTab', space, url }), parseCreatedTab);
    },

    listTabs() {
      return scoped('listTabs', (space) => ({ op: 'listTabs', space }), parseTabs);
    },

    async snapshot(snapshotOptions: EgoSnapshotOptions = {}) {
      const space = selected;
      if (space === undefined) throw codedError(NOT_SELECTED);
      const { targetId, ...rest } = snapshotOptions;
      const target = targetId ?? (await activeTargetId(space));
      if (typeof target !== 'string') throw codedError(target);
      const optionsToSend: SnapshotOptions = rest;
      const answer = checked(
        'snapshot',
        await request({ op: 'snapshot', space, targetId: target, options: optionsToSend }),
        parseSnapshot,
      );
      if ('error' in answer) throw codedError(answer);
      return answer;
    },

    sendCDPMessage(message: string) {
      requireArgument(typeof message === 'string', 'sendCDPMessage', 'message');
      const space = selected;
      if (space === undefined) {
        reportSendError(NOT_SELECTED);
        return;
      }
      void request({ op: 'cdp', space, message }).then((answer) => {
        if ('error' in answer) reportSendError(answer);
      });
    },

    async ledgerLoad(space: number) {
      return checked('ledgerLoad', await request({ op: 'ledgerLoad', space }), parseLedger);
    },

    async ledgerSave(space: number, data: string) {
      return checked('ledgerSave', await request({ op: 'ledgerSave', space, data }), () => null);
    },

    async stageUpload(paths: readonly string[]) {
      requireArgument(
        Array.isArray(paths) && paths.every((path) => typeof path === 'string'),
        'stageUpload',
        'paths',
      );
      return checked('stageUpload', await request({ op: 'stageUpload', paths }), parseStrings);
    },

    async saveFile(source: string, path: string) {
      requireArgument(typeof source === 'string' && typeof path === 'string', 'saveFile', 'path');
      return checked('saveFile', await request({ op: 'saveFile', source, path }), () => null);
    },

    async attachImage(image) {
      return checked('attachImage', await request({ op: 'attachImage', ...image }), (value) =>
        typeof value === 'number' && Number.isInteger(value) ? value : undefined,
      );
    },

    async requestAccess(hosts: readonly string[], reason: string) {
      requireArgument(
        Array.isArray(hosts) && hosts.every((host) => typeof host === 'string'),
        'requestAccess',
        'hosts',
      );
      requireArgument(typeof reason === 'string', 'requestAccess', 'reason');
      return checked(
        'requestAccess',
        await request({ op: 'requestAccess', hosts, reason }),
        parseDecision,
      );
    },
  };

  function reportSendError(failure: EgoErrorResult): void {
    // ego delivers send failures asynchronously, after sendCDPMessage returned.
    setTimeout(() => {
      bindings.onSendCDPMessageError?.(failure.error, failure.error_code);
    }, 0);
  }

  api.onCdp((message) => {
    bindings.onCDPMessage?.(message);
  });
  return bindings;
}

function isFailure(value: unknown): value is BrowserHostFailure {
  return isRecord(value) && typeof value.error === 'string' && typeof value.error_code === 'string';
}

/**
 * ego reports a user-control boundary with the reason key in `error`
 * (`{ error: 'location', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }`); the host answers the
 * message in `error` and the key in `reason`.
 */
function egoError(failure: BrowserHostFailure): EgoErrorResult {
  if (failure.error_code === 'EGO_TASK_SPACE_USER_IN_CONTROL' && failure.reason) {
    return { error: failure.reason, error_code: failure.error_code };
  }
  return { error: failure.error, error_code: failure.error_code };
}

function checked<T>(
  op: string,
  answer: { ok: unknown } | EgoErrorResult,
  parse: (value: unknown) => T | undefined,
): EgoResult<T> {
  if ('error' in answer) return answer;
  const value = parse(answer.ok);
  if (value === undefined) {
    return { error: `${op} returned an invalid result`, error_code: 'EGO_INVALID_RESULT_PAYLOAD' };
  }
  return value;
}

function codedError(failure: EgoErrorResult): ErrorWithCode {
  return Object.assign(new Error(failure.error), { error_code: failure.error_code });
}

function requireArgument(valid: boolean, op: string, name: string): void {
  if (!valid) {
    throw Object.assign(new TypeError(`${op}: invalid ${name}`), {
      error_code: 'EGO_INVALID_ARGUMENT',
    });
  }
}

function parseStatus(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return value === null || value === undefined || isRecord(value) ? 'ok' : undefined;
}

function parseStrings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function parseLedger(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null
    ? value
    : value === undefined
      ? null
      : undefined;
}

function parseDecision(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'allow') return true;
  if (value === 'deny') return false;
  return isRecord(value) && typeof value.allowed === 'boolean' ? value.allowed : undefined;
}

/** A list the host answers either bare or inside ego's envelope (`{ tabs: [...] }`). */
function listOf<T>(
  value: unknown,
  key: string,
  item: (entry: unknown) => entry is T,
): T[] | undefined {
  const list: unknown = isRecord(value) ? value[key] : value;
  return Array.isArray(list) && list.every(item) ? list : undefined;
}

function parseProfiles(value: unknown): { profiles: EgoProfile[] } | undefined {
  const profiles = listOf(value, 'profiles', isProfile);
  return profiles ? { profiles } : undefined;
}

function parseTaskSpaces(value: unknown): { taskSpaces: TaskSpaceInfo[] } | undefined {
  const taskSpaces = listOf(value, 'taskSpaces', isTaskSpace);
  return taskSpaces ? { taskSpaces } : undefined;
}

function parseTaskSpace(value: unknown): TaskSpaceInfo | undefined {
  return isTaskSpace(value) ? value : undefined;
}

function parseTabs(value: unknown): { tabs: TabInfo[] } | undefined {
  const tabs = listOf(value, 'tabs', isTab);
  return tabs ? { tabs } : undefined;
}

function parseCreatedTab(value: unknown): TabInfo | undefined {
  if (isTab(value)) return value;
  // ego's createTab guarantees only `targetId`.
  return isRecord(value) && typeof value.targetId === 'string' && value.targetId
    ? {
        index: -1,
        targetId: value.targetId,
        url: typeof value.url === 'string' ? value.url : '',
        title: typeof value.title === 'string' ? value.title : '',
        active: value.active === true,
        openedBy: 'agent',
      }
    : undefined;
}

function parseSnapshot(value: unknown): SnapshotResult | undefined {
  if (!isRecord(value) || typeof value.content !== 'string' || !Array.isArray(value.refs)) {
    return undefined;
  }
  const refs: unknown[] = value.refs;
  if (!refs.every(isSnapshotRef)) return undefined;
  return { content: value.content, refs, truncated: value.truncated === true };
}

function isProfile(value: unknown): value is EgoProfile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.isDefault === 'boolean'
  );
}

function isTaskSpace(value: unknown): value is TaskSpaceInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.taskId === 'string' &&
    (value.ownership === 'agent' ||
      value.ownership === 'agentDelegatedToUser' ||
      value.ownership === 'user') &&
    (value.createdBy === 'agent' || value.createdBy === 'user') &&
    Array.isArray(value.recentTabTitles) &&
    value.recentTabTitles.every((title) => typeof title === 'string')
  );
}

function isTab(value: unknown): value is TabInfo {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    typeof value.targetId === 'string' &&
    value.targetId.length > 0 &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.active === 'boolean' &&
    (value.openedBy === 'agent' || value.openedBy === 'user' || value.openedBy === 'unknown')
  );
}

function isSnapshotRef(value: unknown): value is SnapshotRef {
  return (
    isRecord(value) &&
    typeof value.refId === 'number' &&
    typeof value.backendNodeId === 'number' &&
    (value.frameId === undefined || typeof value.frameId === 'string') &&
    typeof value.role === 'string' &&
    typeof value.name === 'string' &&
    (value.loc === undefined || typeof value.loc === 'string')
  );
}
