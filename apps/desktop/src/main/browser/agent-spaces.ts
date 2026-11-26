// The agent's Spaces (ADR-0089, design addendum B2.3 and B2.5): what the script host's
// bindings do to a session's browser. A Space has ego-browser's numeric id and ownership:
// `agent` while the agent controls it, `agentDelegatedToUser` after a hand-off or a takeover,
// `user` once the agent finished it with pages kept. Every task-scoped call checks that the
// agent controls the Space. The user's own tabs ("My tabs") are listed only by count and can
// never be claimed by a script (B2.3.4).

import type { WebContents } from 'electron';

import { BROWSER_LIMITS } from '../../shared/browser.js';
import type { BrowserErrorCode, TabInfo, TaskSpaceInfo } from '../../shared/browser-host.js';
import type { ProxySpace, ProxyTab, TabChange } from './cdp-proxy.js';
import type { AgentModel, Space, TabEvent } from './service.js';
import type { BrowserTab } from './tab.js';

/** A binding failure with ego-browser's stable code. */
export class SpaceError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Agent Spaces one session may have at once (B2.3.3). */
export const MAX_AGENT_SPACES = 4;
/** Page ledgers one session keeps (its recent Spaces'). */
const MAX_LEDGERS = 16;
const NAME_CHARS = 80;
const STATE_CHARS = 120;
const TITLE_CHARS = 80;
const RECENT_TITLES = 3;
const USER_SPACE = 'user';

/** What PiArc knows about an agent Space beyond the panel's view of it. */
interface SpaceData {
  readonly numeric: number;
  readonly createdBy: 'agent' | 'user';
  /** The subagent type that created it, shown in the panel (B2.3.3). */
  readonly agentType?: string;
  /** The Space's own active tab (ego's `active`). */
  activeTab: string | undefined;
}

/** Who calls: the session whose Spaces they are, and the subagent type if any. */
export interface SpaceCaller {
  readonly sessionId: string;
  /** The session's workspace, when the run named it. */
  readonly workspace?: string;
  readonly agentType?: string;
  /** Spaces this run used; their `running` mark ends with the run. */
  readonly touched: Set<string>;
}

export interface AgentSpacesDeps {
  model(sessionId: string, workspace?: string): Promise<AgentModel>;
  /** The agent handed a Space to the user (B2.5.3): reveal it and tell the user. */
  handedOff(sessionId: string, space: string, reason: string): void;
}

/**
 * Whether the agent controls `space` now, running or between its calls (B1.3.2): its pages get
 * no permission prompts and no earlier grants.
 */
export function agentHolds(space: Pick<Space, 'kind' | 'ownership'> | undefined): boolean {
  return space?.kind === 'agent' && space.ownership === 'agent';
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

export class AgentSpaces {
  readonly #data = new Map<string, SpaceData>();
  readonly #numeric = new Map<number, { sessionId: string; space: string }>();
  readonly #targets = new WeakMap<WebContents, Promise<string>>();
  /** Page ledgers by `<session>/<space id>`, in insertion order. */
  readonly #ledgers = new Map<string, string>();
  #next = 1;

  constructor(private readonly deps: AgentSpacesDeps) {}

  async list(caller: SpaceCaller): Promise<TaskSpaceInfo[]> {
    const model = await this.deps.model(caller.sessionId, caller.workspace);
    return model.spaces.map((space) => this.#info(model, space));
  }

  async create(caller: SpaceCaller, name: string): Promise<TaskSpaceInfo> {
    const model = await this.deps.model(caller.sessionId, caller.workspace);
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > NAME_CHARS) {
      throw new SpaceError(
        'EGO_INVALID_ARGUMENT',
        `A task space name has 1-${String(NAME_CHARS)} characters`,
      );
    }
    if (model.spaces.some((s) => s.kind === 'agent' && s.name === trimmed)) {
      throw new SpaceError('EGO_TASK_SPACE_NAME_IN_USE', `Task space name in use: ${trimmed}`);
    }
    if (model.spaces.filter((s) => s.kind === 'agent').length >= MAX_AGENT_SPACES) {
      throw new SpaceError(
        'PIARC_LIMIT',
        `This session already has ${String(MAX_AGENT_SPACES)} task spaces; finish one first`,
      );
    }
    const numeric = this.#next++;
    const space: Space = {
      id: `agent-${String(numeric)}`,
      name: trimmed,
      kind: 'agent',
      ownership: 'agent',
      running: true,
    };
    model.spaces.push(space);
    const data: SpaceData = {
      numeric,
      createdBy: 'agent',
      ...(caller.agentType === undefined ? {} : { agentType: caller.agentType }),
      activeTab: undefined,
    };
    this.#numeric.set(numeric, { sessionId: model.sessionId, space: space.id });
    this.#data.set(this.#key(model, space.id), data);
    caller.touched.add(space.id);
    // A new Space starts with one blank page (ego's `p1`).
    const tab = model.newTab(space.id, 'about:blank');
    model.contents(tab);
    data.activeTab = tab.id;
    model.changed();
    return this.#info(model, space);
  }

  /**
   * The user shared one of their own tabs (B2.3.4): it moves into a new Space the user owns,
   * which the agent lists with its titles and claims before working in it. The tab stays
   * `openedBy: "user"`, so the SDK's `finish` keeps it. Answers the Space's numeric id, or
   * undefined when `tabId` is not one of the user's own tabs.
   */
  async share(sessionId: string, tabId: string): Promise<number | undefined> {
    const model = await this.deps.model(sessionId);
    const tab = model.tabs.find((t) => t.id === tabId && t.space === USER_SPACE);
    if (tab === undefined) return undefined;
    if (model.spaces.filter((s) => s.kind === 'agent').length >= MAX_AGENT_SPACES) {
      throw new SpaceError(
        'PIARC_LIMIT',
        `This session already has ${String(MAX_AGENT_SPACES)} task spaces`,
      );
    }
    const title = clip(`Shared: ${tab.title === '' ? tab.url : tab.title}`, NAME_CHARS);
    const taken = (name: string) => model.spaces.some((s) => s.kind === 'agent' && s.name === name);
    let name = title;
    for (let n = 2; taken(name); n += 1) name = clip(`${title} (${String(n)})`, NAME_CHARS);
    const numeric = this.#next++;
    const space: Space = {
      id: `agent-${String(numeric)}`,
      name,
      kind: 'agent',
      ownership: 'user',
      running: false,
    };
    model.spaces.push(space);
    this.#numeric.set(numeric, { sessionId: model.sessionId, space: space.id });
    this.#data.set(this.#key(model, space.id), {
      numeric,
      createdBy: 'user',
      activeTab: tab.id,
    });
    tab.space = space.id;
    model.changed();
    return numeric;
  }

  async claim(caller: SpaceCaller, id: number, name?: string): Promise<TaskSpaceInfo> {
    const { model, space } = await this.#find(caller, id);
    if (space.id === USER_SPACE) {
      throw new SpaceError(
        'EGO_TASK_SPACE_USER_IN_CONTROL',
        "The user's own tabs are not shared with the agent; ask the user to open the page in your task space",
        'user_space',
      );
    }
    if (space.ownership === 'agentDelegatedToUser') {
      throw new SpaceError(
        'EGO_TASK_SPACE_USER_IN_CONTROL',
        `Task space ${String(id)} is under the user's control; use takeOverTaskSpace(${String(id)}) once the user hands it back`,
        'manual_takeover',
      );
    }
    space.ownership = 'agent';
    space.running = true;
    if (name !== undefined && name.trim() !== '') space.name = clip(name.trim(), NAME_CHARS);
    caller.touched.add(space.id);
    model.changed();
    return this.#info(model, space);
  }

  async close(caller: SpaceCaller, id: number): Promise<string> {
    const { model, space } = await this.#controlled(caller, id);
    for (const tab of model.tabs.filter((t) => t.space === space.id)) model.closeTab(tab.id);
    this.#remove(model, space);
    return `${String(id)} task space closed.`;
  }

  async complete(caller: SpaceCaller, id: number): Promise<string> {
    const { model, space } = await this.#controlled(caller, id);
    if (!model.tabs.some((t) => t.space === space.id)) {
      this.#remove(model, space);
    } else {
      space.ownership = 'user';
      space.running = false;
      delete space.action;
      model.changed();
    }
    return `${String(id)} task space completed.`;
  }

  async handOff(caller: SpaceCaller, id: number, reason: string): Promise<string> {
    const { model, space } = await this.#controlled(caller, id);
    space.ownership = 'agentDelegatedToUser';
    space.running = false;
    space.handOff = clip(reason.trim(), STATE_CHARS);
    delete space.action;
    model.changed();
    this.deps.handedOff(model.sessionId, space.id, space.handOff);
    return `${String(id)} has been handed off to the user.`;
  }

  async takeOver(caller: SpaceCaller, id: number): Promise<string> {
    const { model, space } = await this.#find(caller, id);
    if (space.id === USER_SPACE || space.ownership === 'user') {
      throw new SpaceError(
        'EGO_TASK_SPACE_INACTIVE',
        `Task space ${String(id)} was finished; claim it with claimTaskSpace(${String(id)})`,
      );
    }
    // Only a hand-off the agent asked for may be resumed by the agent; a Space the user took
    // over stays theirs until they hand it back in the panel (B2.5.2).
    if (space.ownership === 'agentDelegatedToUser' && space.handOff === undefined) {
      throw new SpaceError(
        'EGO_TASK_SPACE_USER_IN_CONTROL',
        `The user took control of task space ${String(id)}; it comes back when they hand it back. Do not retry.`,
        'manual_takeover',
      );
    }
    space.ownership = 'agent';
    space.running = true;
    delete space.handOff;
    caller.touched.add(space.id);
    model.changed();
    return `${String(id)} has been taken over by the agent.`;
  }

  /** The user took a Space over from the panel (B2.5.2). */
  async userTakeOver(sessionId: string, spaceId: string): Promise<void> {
    const model = await this.deps.model(sessionId);
    const space = model.spaces.find((s) => s.id === spaceId && s.kind === 'agent');
    if (space?.ownership !== 'agent') return;
    space.ownership = 'agentDelegatedToUser';
    space.running = false;
    delete space.action;
    model.changed();
  }

  /** The user gave a Space back (B2.5.3); whether the agent had asked for it (a hand-off). */
  async userHandBack(sessionId: string, spaceId: string): Promise<boolean> {
    const model = await this.deps.model(sessionId);
    const space = model.spaces.find((s) => s.id === spaceId && s.kind === 'agent');
    if (space?.ownership !== 'agentDelegatedToUser') return false;
    const asked = space.handOff !== undefined;
    space.ownership = 'agent';
    delete space.handOff;
    model.changed();
    return asked;
  }

  async setState(caller: SpaceCaller, id: number, state: string): Promise<string> {
    const { model, space } = await this.#controlled(caller, id);
    const text = clip(state.trim(), STATE_CHARS);
    if (text === '') delete space.action;
    else space.action = text;
    model.changed();
    return `${String(id)} state updated.`;
  }

  async createTab(caller: SpaceCaller, id: number, url: string): Promise<TabInfo> {
    const { model, space, data } = await this.#controlled(caller, id);
    if (model.tabs.length >= BROWSER_LIMITS.tabs) {
      throw new SpaceError('PIARC_LIMIT', `At most ${String(BROWSER_LIMITS.tabs)} tabs`);
    }
    const tab = model.newTab(space.id, url === '' ? 'about:blank' : url);
    model.contents(tab);
    data.activeTab = tab.id;
    model.select(tab.id);
    return this.#tabInfo(model, space, tab);
  }

  async listTabs(caller: SpaceCaller, id: number): Promise<TabInfo[]> {
    const { model, space } = await this.#controlled(caller, id);
    const tabs = model.tabs.filter((t) => t.space === space.id);
    return Promise.all(tabs.map((tab) => this.#tabInfo(model, space, tab)));
  }

  /** The tab of `targetId` in a Space the agent controls, with its page. */
  async tab(
    caller: SpaceCaller,
    id: number,
    targetId: string,
  ): Promise<{ readonly tab: BrowserTab; readonly contents: WebContents }> {
    const { model, space } = await this.#controlled(caller, id);
    for (const tab of model.tabs.filter((t) => t.space === space.id)) {
      const contents = model.contents(tab);
      if ((await this.#targetId(contents)) === targetId) return { tab, contents };
    }
    throw new SpaceError(
      'EGO_WEB_CONTENTS_UNAVAILABLE',
      `No tab ${targetId} in task space ${String(id)}`,
    );
  }

  /**
   * The SDK's Page ledger of Space `id` (JSON text), or null. Like ego's ledger files it is
   * the SDK's own bookkeeping, kept per session while PiArc runs: it outlives the Space (the SDK
   * discards it after closing one) and does not depend on who controls the Space.
   */
  ledger(caller: SpaceCaller, id: number): string | null {
    return this.#ledgers.get(`${caller.sessionId}/${String(id)}`) ?? null;
  }

  /** Replaces the ledger of Space `id`; an empty text discards it. */
  saveLedger(caller: SpaceCaller, id: number, ledger: string): void {
    const key = `${caller.sessionId}/${String(id)}`;
    this.#ledgers.delete(key);
    if (ledger === '') return;
    this.#ledgers.set(key, ledger);
    // The oldest go first: a session keeps the ledgers of its recent Spaces only.
    const own = [...this.#ledgers.keys()].filter((k) => k.startsWith(`${caller.sessionId}/`));
    for (const old of own.slice(0, Math.max(0, own.length - MAX_LEDGERS))) {
      this.#ledgers.delete(old);
    }
  }

  /** The Space as the CDP proxy sees it, for one run. */
  async proxySpace(
    caller: SpaceCaller,
    id: number,
    run: {
      stagedFile(path: string): boolean;
      refused(method: string): void;
      cancelDownload(guid: string): boolean;
    },
  ): Promise<ProxySpace> {
    const { model, space, data } = await this.#controlled(caller, id);
    // Tab id → what the proxy last told the SDK about it (a closed tab keeps its target id).
    const tracked = new Map<string, ProxyTab>();
    const describe = async (tab: BrowserTab): Promise<ProxyTab> => {
      const known: ProxyTab = {
        targetId: await this.#targetId(model.contents(tab)),
        url: tab.url,
        title: tab.title,
      };
      tracked.set(tab.id, known);
      return known;
    };
    for (const tab of model.tabs.filter((t) => t.space === space.id)) await describe(tab);
    const check = () => {
      if (space.ownership !== 'agent') {
        throw new SpaceError(
          'EGO_TASK_SPACE_USER_IN_CONTROL',
          'The user controls this task space',
          'manual_takeover',
        );
      }
    };
    const onEvent = (event: TabEvent, listener: (change: TabChange) => void) => {
      if (event.tab.space !== space.id) return;
      const before = tracked.get(event.tab.id);
      if (event.kind === 'destroyed') {
        tracked.delete(event.tab.id);
        if (before !== undefined) listener({ kind: 'destroyed', targetId: before.targetId });
        return;
      }
      // A discarded page has no view; describing it would load it again.
      if (event.kind === 'changed' && event.tab.view === undefined) return;
      if (before?.url === event.tab.url && before.title === event.tab.title) return;
      describe(event.tab).then(
        (tab) => {
          listener({ kind: before === undefined ? 'created' : 'changed', tab });
        },
        () => undefined,
      );
    };
    return {
      tabs: () => [...tracked.values()],
      debuggerOf: async (targetId) => {
        check();
        const { contents } = await this.tab(caller, id, targetId);
        return contents.debugger;
      },
      createTab: async (url) => {
        check();
        const info = await this.createTab(caller, id, url);
        const tab = model.tabs.find(
          (t) => t.space === space.id && tracked.get(t.id)?.targetId === info.targetId,
        );
        return (
          (tab === undefined ? undefined : tracked.get(tab.id)) ?? {
            targetId: info.targetId,
            url: info.url,
            title: info.title,
          }
        );
      },
      closeTab: async (targetId) => {
        check();
        const { tab } = await this.tab(caller, id, targetId);
        model.closeTab(tab.id);
        // ego closes a task space with its last tab.
        if (!model.tabs.some((t) => t.space === space.id)) this.#remove(model, space);
        return true;
      },
      activate: (targetId) => {
        this.tab(caller, id, targetId).then(
          ({ tab }) => {
            data.activeTab = tab.id;
            model.select(tab.id);
          },
          () => undefined,
        );
      },
      watch: (listener) =>
        model.watch((event) => {
          onEvent(event, listener);
        }),
      stagedFile: (path) => run.stagedFile(path),
      cancelDownload: (guid) => run.cancelDownload(guid),
      refused: (method) => {
        run.refused(method);
      },
      tainted: (targetId) => {
        const tab = model.tabs.find(
          (t) => t.space === space.id && tracked.get(t.id)?.targetId === targetId,
        );
        if (tab !== undefined && !tab.tainted) {
          tab.tainted = true;
          model.changed();
        }
      },
      emulated: (targetId, emulation) => {
        const tab = model.tabs.find(
          (t) => t.space === space.id && tracked.get(t.id)?.targetId === targetId,
        );
        if (tab === undefined) return;
        // Shown with the panel's badge until the user resets it (B1.4.2).
        tab.emulation =
          emulation === null
            ? null
            : { ...emulation, touch: tab.emulation?.touch ?? false, by: 'agent' };
        model.changed();
      },
    };
  }

  /** Fails unless the agent controls Space `id` (raw CDP sends check it first, as ego does). */
  async control(caller: SpaceCaller, id: number): Promise<void> {
    await this.#controlled(caller, id);
  }

  /** The run ended: its Spaces stop showing the agent at work. */
  async settle(caller: SpaceCaller): Promise<void> {
    const model = await this.deps.model(caller.sessionId, caller.workspace);
    for (const id of caller.touched) {
      const space = model.spaces.find((s) => s.id === id);
      if (space === undefined) continue;
      space.running = false;
      delete space.action;
    }
    model.changed();
  }

  #key(model: AgentModel, space: string): string {
    return `${model.sessionId}/${space}`;
  }

  /** Every Space gets a numeric id the first time a script sees it. */
  #numericOf(model: AgentModel, space: Space): number {
    const key = this.#key(model, space.id);
    let data = this.#data.get(key);
    if (data === undefined) {
      const numeric = this.#next++;
      data = { numeric, createdBy: 'user', activeTab: undefined };
      this.#data.set(key, data);
      this.#numeric.set(numeric, { sessionId: model.sessionId, space: space.id });
    }
    return data.numeric;
  }

  #info(model: AgentModel, space: Space): TaskSpaceInfo {
    const id = this.#numericOf(model, space);
    const data = this.#data.get(this.#key(model, space.id));
    const tabs = model.tabs.filter((t) => t.space === space.id);
    const own = space.id === USER_SPACE;
    const name = own ? `My tabs (${String(tabs.length)})` : space.name;
    return {
      id,
      name,
      taskId: name,
      ownership: space.ownership,
      createdBy: own ? 'user' : (data?.createdBy ?? 'agent'),
      // The user's own tabs are not described to the agent (B2.3.4).
      recentTabTitles: own
        ? []
        : tabs
            .slice(-RECENT_TITLES)
            .map((t) => clip(t.title === '' ? t.url : t.title, TITLE_CHARS)),
    };
  }

  async #tabInfo(model: AgentModel, space: Space, tab: BrowserTab): Promise<TabInfo> {
    const tabs = model.tabs.filter((t) => t.space === space.id);
    const data = this.#data.get(this.#key(model, space.id));
    return {
      index: tabs.indexOf(tab),
      targetId: await this.#targetId(model.contents(tab)),
      url: tab.url,
      title: tab.title,
      active: (data?.activeTab ?? tabs.at(-1)?.id) === tab.id,
      openedBy: tab.openedBy,
    };
  }

  /** The page's own CDP target id (its main frame's id). */
  targetIdOf(contents: WebContents): Promise<string> {
    return this.#targetId(contents);
  }

  #targetId(contents: WebContents): Promise<string> {
    let pending = this.#targets.get(contents);
    if (pending === undefined) {
      pending = (async () => {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        const info: unknown = await contents.debugger.sendCommand('Target.getTargetInfo');
        const targetId =
          typeof info === 'object' && info !== null && 'targetInfo' in info
            ? (info.targetInfo as { targetId?: unknown }).targetId
            : undefined;
        if (typeof targetId !== 'string')
          throw new SpaceError('EGO_WEB_CONTENTS_UNAVAILABLE', 'The page has no target id');
        return targetId;
      })();
      pending.catch(() => this.#targets.delete(contents));
      this.#targets.set(contents, pending);
    }
    return pending;
  }

  async #find(caller: SpaceCaller, id: number) {
    const located = this.#numeric.get(id);
    const model = await this.deps.model(caller.sessionId, caller.workspace);
    const space =
      located?.sessionId === model.sessionId
        ? model.spaces.find((s) => s.id === located.space)
        : undefined;
    const data = space === undefined ? undefined : this.#data.get(this.#key(model, space.id));
    if (space === undefined || data === undefined) {
      throw new SpaceError('EGO_TASK_SPACE_NOT_FOUND', `Task space not found: ${String(id)}`);
    }
    return { model, space, data };
  }

  async #controlled(caller: SpaceCaller, id: number) {
    const found = await this.#find(caller, id);
    const { space } = found;
    if (space.id === USER_SPACE || space.ownership === 'user') {
      throw new SpaceError(
        'EGO_TASK_SPACE_INACTIVE',
        `Task space ${String(id)} is not yours; claim it with claimTaskSpace(${String(id)})`,
      );
    }
    if (space.ownership === 'agentDelegatedToUser') {
      throw new SpaceError(
        'EGO_TASK_SPACE_USER_IN_CONTROL',
        space.handOff === undefined
          ? 'The user took control of this task space'
          : `Waiting for the user: ${space.handOff}`,
        space.handOff === undefined ? 'manual_takeover' : 'handoff',
      );
    }
    caller.touched.add(space.id);
    if (!space.running) {
      space.running = true;
      found.model.changed();
    }
    return found;
  }

  #remove(model: AgentModel, space: Space): void {
    const index = model.spaces.indexOf(space);
    if (index >= 0) model.spaces.splice(index, 1);
    const data = this.#data.get(this.#key(model, space.id));
    if (data !== undefined) this.#numeric.delete(data.numeric);
    this.#data.delete(this.#key(model, space.id));
    model.changed();
  }
}
