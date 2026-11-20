// One session's conversation in the renderer (architecture sections 8.2–8.4): Core's session
// notifications and history windows reduced into rows by one reducer, so the live stream and a
// reopened session show the same rows (T19). Every row has its own subscribers: a streaming
// delta re-renders only the row it extends (section 8.3, rule 3).
//
// Rows:
// - `item`: one item from Core (user message, reply, thinking, bash command, file change,
//   compaction, other tool call), with the times Core reported it started and completed.
// - `group`: consecutive tool calls other than shell commands, shown as one summary (verb,
//   object, lines added and removed) that expands to the calls; derived from the item order,
//   the same way for history and live items.
// - `optimistic`: the user's input shown at once with a `clientId`; Core's user message
//   replaces it in place (rule 1). When Core did not take it, it stays as undelivered.
// - `error`: a failed turn with Core's kind of failure and whether a retry may succeed.
// - `uncertain`: the Agent Host restarted during the turn; its outcome is unknown.
// - `working`: the last row while a turn runs.
//
// Everything the rows show comes from Core's events: item states, error kinds and retry counts
// are never inferred here (architecture principle 8).
import type {
  ApprovalRequest,
  InputAttachment,
  InputMention,
  Item,
  SubagentState,
  TurnErrorKind,
  TurnUsage,
} from '@piarc/protocol';

import { sameRequest } from './approvals.js';
import { SessionContextUsage } from './context-usage.js';
import { SessionBranches } from './branches.js';
import { SessionChanges } from './changes.js';
import { SessionHarness } from './harness.js';
import type { PendingAttachment } from '../composer/attachments.js';

/** An attachment as the user message shows it: a stored attachment or one being sent. */
export interface AttachmentChip {
  readonly kind: 'image' | 'pdf';
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly pageCount?: number;
}

/** The user's input as the transcript shows it before Core echoes it. */
export interface ShownInput {
  readonly text: string;
  readonly mentions: readonly InputMention[];
  readonly attachments: readonly AttachmentChip[];
}

/** What a retry sends again: the turn's input as Core stored it. */
export interface StoredInput {
  readonly text: string;
  readonly mentions: readonly InputMention[];
  readonly attachments: readonly InputAttachment[];
}

/** Files to recover if the user resends an optimistic message after switching sessions. */
export interface DraftFiles {
  readonly pending: readonly PendingAttachment[];
  readonly stored: readonly InputAttachment[];
}

export interface TranscriptEntry {
  readonly entryId: string;
  readonly turnId?: string;
  readonly item: unknown;
}

export type TranscriptRow =
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly turnId: string | undefined;
      readonly item: Item;
      /** Core's time of the first event of the item (ms since the epoch); absent in history. */
      readonly startedAt?: number;
      /** Core's time of `item/completed`; absent in history. */
      readonly endedAt?: number;
    }
  | { readonly kind: 'group'; readonly id: string; readonly members: readonly string[] }
  | {
      readonly kind: 'optimistic';
      readonly id: string;
      readonly clientId: string;
      readonly input: ShownInput;
      readonly files: DraftFiles;
      /** The turn Core started for it, once the prompt was accepted. */
      readonly turnId: string | undefined;
      readonly state: 'sending' | 'undelivered';
      /** Why it was not delivered. */
      readonly failure: string | undefined;
    }
  | {
      readonly kind: 'error';
      readonly id: string;
      readonly turnId: string;
      readonly errorKind: TurnErrorKind;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: 'uncertain'; readonly id: string; readonly turnId: string }
  | {
      readonly kind: 'approval';
      readonly id: string;
      readonly request: ApprovalRequest;
      readonly turnId?: string;
    }
  | { readonly kind: 'working'; readonly id: string };

/** The running turn as the working row shows it. */
export interface TurnInfo {
  readonly running: boolean;
  readonly turnId: string | undefined;
  /** Core's time of `turn/started`. */
  readonly startedAt: number | undefined;
  /** The automatic retry in progress (`turn/retrying`), until the next response arrives. */
  readonly retry: { readonly attempt: number; readonly max: number } | undefined;
  /** The turn's usage so far (`turn/usage`). */
  readonly usage: TurnUsage | undefined;
  /** Tool items in progress, in the order they started. */
  readonly openTools: readonly string[];
  /** A compaction in progress. */
  readonly compacting: boolean;
}

/** The id of the working row. */
export const WORKING_ROW = 'working';

const IDLE: TurnInfo = {
  running: false,
  turnId: undefined,
  startedAt: undefined,
  retry: undefined,
  usage: undefined,
  openTools: [],
  compacting: false,
};

/**
 * Item types folded into a tool group: every tool call but shell commands and subagents (T31),
 * which keep a card of their own (status, exit code, timer; the run). A group expands to its calls; file changes then show
 * their diff cards.
 */
const GROUPED_TYPES = new Set(['dynamicToolCall', 'mcpToolCall', 'webFetch', 'fileChange']);

/** Host tools with rows of their own (T26): the task card, the plan card, the answered
 * questions and the next steps. */
export const OWN_ROW_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'AskUserQuestion',
  'SuggestNextSteps',
]);

const RUN_STATUS = new Set(['running', 'completed', 'partial', 'failed', 'interrupted']);

/** A `subagent/*` notification's state, when it has the members the card reads. */
function subagentStateOf(value: unknown): SubagentState | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    !('status' in value) ||
    !('toolCalls' in value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.status !== 'string' ||
    !RUN_STATUS.has(value.status) ||
    typeof value.toolCalls !== 'number'
  ) {
    return undefined;
  }
  return value as SubagentState;
}

/** A background run's call completes with the run still going: a later item event must not
 * take back the end the `subagent/completed` notification already showed. */
function keepFinishedRun(previous: Item, next: Item): Item {
  if (
    previous.type === 'subagent' &&
    next.type === 'subagent' &&
    previous.subagent != null &&
    previous.subagent.status !== 'running' &&
    next.subagent?.status === 'running'
  ) {
    return { ...next, subagent: previous.subagent };
  }
  return next;
}

export function isGrouped(item: Item): boolean {
  return (
    GROUPED_TYPES.has(item.type) &&
    !(item.type === 'dynamicToolCall' && OWN_ROW_TOOLS.has(item.tool))
  );
}

function isTool(item: Item): boolean {
  return 'tool' in item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An item as Core sends it: an object with string `itemId` and `type`. System reminders
 * (T27) are rows too; only the detailed view shows them (`transcript/detail.ts`, T29). */
function isItem(value: unknown): value is Item {
  return isRecord(value) && typeof value.itemId === 'string' && typeof value.type === 'string';
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const ERROR_KINDS: readonly TurnErrorKind[] = [
  'auth',
  'rateLimit',
  'provider',
  'network',
  'contextOverflow',
  'invalidRequest',
  'internal',
];

function errorKindOf(value: unknown): TurnErrorKind {
  return ERROR_KINDS.find((kind) => kind === value) ?? 'internal';
}

/** An attachment of an item or a queued input, as its chip shows it. */
export function chipOf(value: unknown): AttachmentChip[] {
  if (
    !isRecord(value) ||
    (value.kind !== 'image' && value.kind !== 'pdf') ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string'
  ) {
    return [];
  }
  const size = isRecord(value.blob) ? numberOr(value.blob.size) : numberOr(value.size);
  const pageCount = numberOr(value.pageCount);
  return [
    {
      kind: value.kind,
      name: value.name,
      mimeType: value.mimeType,
      size: size ?? 0,
      ...(pageCount === undefined ? {} : { pageCount }),
    },
  ];
}

function usageOf(value: unknown): TurnUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const count = (name: string): number => numberOr(value[name]) ?? 0;
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    cost: count('cost'),
  };
}

/** A queued input as the composer lists it. */
export interface QueuedInput {
  readonly itemId: string;
  readonly kind: 'steer' | 'followUp';
  readonly text: string;
  readonly attachments: readonly AttachmentChip[];
}

function queueItemOf(value: unknown): QueuedInput[] {
  if (
    !isRecord(value) ||
    typeof value.itemId !== 'string' ||
    (value.kind !== 'steer' && value.kind !== 'followUp') ||
    typeof value.text !== 'string'
  ) {
    return [];
  }
  const attachments = Array.isArray(value.attachments) ? value.attachments.flatMap(chipOf) : [];
  return [{ itemId: value.itemId, kind: value.kind, text: value.text, attachments }];
}

function optimisticId(clientId: string): string {
  return `optimistic:${clientId}`;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class SessionTranscript {
  // Pi entry ids are local to one history. The store keeps this instance across view switches.
  private readonly cachePrefix = crypto.randomUUID();

  /** Key for this row in the window's shared presentation caches and Markdown worker. */
  cacheKey(id: string): string {
    return this.cachePrefix + '/' + id;
  }

  /** Source rows in conversation order (items, optimistic, error, uncertain). */
  private order: string[] = [];
  /** The rows shown, in order: groups in place of their members, the working row last. */
  private display: readonly string[] = [];
  private readonly rows = new Map<string, TranscriptRow>();
  private approvalIds: string[] = [];
  /** The branch's plan and task list (T26). */
  readonly harness = new SessionHarness();
  readonly usage = new SessionContextUsage();
  /** Where other branches start (T28). */
  readonly branches = new SessionBranches();
  /** The files the session changed (T28). */
  readonly changes = new SessionChanges();
  private turn: TurnInfo = IDLE;
  private queueItems: readonly QueuedInput[] = [];
  private reload = false;
  /** Cache of `userTurns`, cleared when rows are added or removed. */
  private turnStarts:
    | readonly { readonly turnId: string; readonly rowId: string; readonly text: string }[]
    | undefined;
  private loadedFrom: number | undefined;
  private readonly rowListeners = new Map<string, Set<() => void>>();
  private readonly listListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private readonly queueListeners = new Set<() => void>();
  private readonly changeListeners = new Set<(ids: readonly string[]) => void>();

  /** Replaces the live approval rows from a revision-checked entity snapshot. */
  setApprovals(requests: readonly ApprovalRequest[]): void {
    const ids = requests.map(
      (r) => `approval:${String(r.connectionEpoch)}:${r.requestId}:${String(r.revision)}`,
    );
    const batch = new Batch();
    for (const id of this.approvalIds) {
      if (!ids.includes(id)) {
        this.rows.delete(id);
        batch.changed.add(id);
      }
    }
    requests.forEach((request, i) => {
      const id = ids[i];
      if (id === undefined) return;
      const existing = this.rows.get(id);
      if (existing?.kind === 'approval' && sameRequest(request, existing.request)) return;
      this.rows.set(id, { kind: 'approval', id, request });
      batch.changed.add(id);
    });
    batch.list = !sameList(this.approvalIds, ids);
    this.approvalIds = ids;
    this.finish(batch);
  }

  rowIds(): readonly string[] {
    return this.display;
  }

  row(id: string): TranscriptRow | undefined {
    return this.rows.get(id);
  }

  isRunning(): boolean {
    return this.turn.running;
  }

  turnInfo(): TurnInfo {
    return this.turn;
  }

  queue(): readonly QueuedInput[] {
    return this.queueItems;
  }

  /** The first user message of each turn, in order (T28: rewinding and branching start there). */
  userTurns(): readonly {
    readonly turnId: string;
    readonly rowId: string;
    readonly text: string;
  }[] {
    if (this.turnStarts === undefined) {
      const seen = new Set<string>();
      const starts: { turnId: string; rowId: string; text: string }[] = [];
      for (const id of this.order) {
        const row = this.rows.get(id);
        if (row?.kind !== 'item' || row.item.type !== 'userMessage' || row.turnId === undefined) {
          continue;
        }
        if (seen.has(row.turnId)) continue;
        seen.add(row.turnId);
        starts.push({ turnId: row.turnId, rowId: id, text: row.item.text });
      }
      this.turnStarts = starts;
    }
    return this.turnStarts;
  }

  /** Whether row `id` is the first user message of its turn. */
  isTurnStart(id: string): boolean {
    return this.userTurns().some((turn) => turn.rowId === id);
  }

  /** Core said notifications were lost: the persisted conversation must be loaded again. */
  needsReload(): boolean {
    return this.reload;
  }

  /** Whether any row came from Core (history or live). */
  hasContent(): boolean {
    return this.order.length > 0;
  }

  /**
   * Applies Core's notifications for this session (`{ method, params }`, in `seq` order).
   * Malformed or unknown notifications are skipped.
   */
  apply(notifications: readonly unknown[]): void {
    const batch = new Batch();
    for (const notification of notifications) {
      if (isRecord(notification) && isRecord(notification.params)) {
        this.applyOne(String(notification.method), notification.params, batch);
      }
    }
    this.finish(batch);
  }

  /**
   * Replaces the rows with a window of the persisted conversation (a session opened again, or
   * reloaded after lost notifications). Optimistic rows still waiting stay at the end.
   */
  load(items: readonly TranscriptEntry[], start?: number): void {
    this.loadedFrom = start;
    const batch = new Batch();
    const pending = this.order.filter((id) => this.rows.get(id)?.kind === 'optimistic');
    for (const id of this.order) {
      if (!pending.includes(id)) {
        this.rows.delete(id);
        batch.changed.add(id);
      }
    }
    this.order = [];
    for (const { turnId, item } of items) {
      if (isItem(item) && !this.rows.has(item.itemId)) {
        this.rows.set(item.itemId, { kind: 'item', id: item.itemId, turnId, item });
        this.order.push(item.itemId);
      }
    }
    this.order.push(...pending);
    this.reload = false;
    batch.list = true;
    batch.state = true;
    this.finish(batch);
  }

  /**
   * Puts an earlier window of the persisted conversation before the rows loaded so far (the
   * user scrolled to the top).
   */
  prepend(items: readonly TranscriptEntry[], start: number): void {
    this.loadedFrom = start;
    const batch = new Batch();
    const earlier: string[] = [];
    for (const { turnId, item } of items) {
      if (isItem(item) && !this.rows.has(item.itemId)) {
        this.rows.set(item.itemId, { kind: 'item', id: item.itemId, turnId, item });
        earlier.push(item.itemId);
      }
    }
    if (earlier.length > 0) {
      this.order = [...earlier, ...this.order];
      batch.list = true;
    }
    this.finish(batch);
  }

  /** Shows the user's input at once (before Core has it). */
  addOptimistic(clientId: string, input: ShownInput): void {
    const id = optimisticId(clientId);
    const batch = new Batch();
    this.rows.set(id, {
      kind: 'optimistic',
      id,
      clientId,
      input,
      files: { pending: [], stored: [] },
      turnId: undefined,
      state: 'sending',
      failure: undefined,
    });
    this.order = this.order.filter((other) => other !== id);
    this.order.push(id);
    batch.changed.add(id);
    batch.list = true;
    this.finish(batch);
  }

  /** Core accepted the input as turn `turnId`. */
  confirm(clientId: string, turnId: string, stored: readonly InputAttachment[] = []): void {
    const id = optimisticId(clientId);
    const row = this.rows.get(id);
    if (row?.kind !== 'optimistic') {
      return;
    }
    const echoed = this.order.some((other) => {
      const candidate = this.rows.get(other);
      return (
        candidate?.kind === 'item' &&
        candidate.turnId === turnId &&
        candidate.item.type === 'userMessage'
      );
    });
    if (echoed) {
      this.remove(id);
      return;
    }
    this.update(id, {
      ...row,
      turnId,
      state: 'sending',
      failure: undefined,
      files: { pending: [], stored },
    });
  }

  /** Core did not take the input: it stays, marked as not delivered, for a resend. */
  markUndelivered(clientId: string, failure: string, files?: DraftFiles): void {
    const id = optimisticId(clientId);
    const row = this.rows.get(id);
    if (row?.kind === 'optimistic' && row.turnId === undefined) {
      this.update(id, { ...row, state: 'undelivered', failure, files: files ?? row.files });
    }
  }

  /** The input is being sent again. */
  markSending(clientId: string): void {
    const id = optimisticId(clientId);
    const row = this.rows.get(id);
    if (row?.kind === 'optimistic') {
      this.update(id, { ...row, state: 'sending', failure: undefined });
    }
  }

  /** The input failed and the user gets it back: the optimistic row goes away. */
  rollback(clientId: string): void {
    this.remove(optimisticId(clientId));
  }

  /**
   * What a retry of turn `turnId` sends again: its first user message as Core stored it, or the
   * optimistic row Core accepted for it when no user message arrived.
   */
  retryInput(turnId: string): { kind: 'stored' | 'client'; input: StoredInput } | undefined {
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row?.kind === 'item' && row.turnId === turnId && row.item.type === 'userMessage') {
        return {
          kind: 'stored',
          input: {
            text: row.item.text,
            mentions: row.item.mentions ?? [],
            attachments: row.item.attachments ?? [],
          },
        };
      }
    }
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row?.kind === 'optimistic' && row.turnId === turnId) {
        return {
          kind: 'client',
          input: {
            text: row.input.text,
            mentions: row.input.mentions,
            attachments: row.files.stored,
          },
        };
      }
    }
    return undefined;
  }

  /** Index of the first loaded item of the persisted conversation; undefined before a load. */
  historyStart(): number | undefined {
    return this.loadedFrom;
  }

  /** Select the whole turn, including steers, grouped tools and the working row. Older
   * windows without turn IDs start a new exchange at each user message. */
  exchangeOf(rowId: string): readonly string[] {
    const at = this.display.indexOf(rowId);
    if (at === -1) return [];
    let current: string | undefined;
    let start = 0;
    for (const [index, id] of this.display.entries()) {
      let row = this.rows.get(id);
      if (row?.kind === 'group') row = this.rows.get(row.members[0] ?? '');
      if (row === undefined || row.kind === 'group') continue;
      const turn = row.kind === 'working' ? this.turn.turnId : row.turnId;
      const starts =
        row.kind === 'optimistic' || (row.kind === 'item' && row.item.type === 'userMessage');
      const next: string | undefined = turn ?? (starts ? id : current);
      if (next !== current) {
        if (index > at) return this.display.slice(start, index);
        current = next;
        start = index;
      }
    }
    return this.display.slice(start);
  }

  subscribeList(listener: () => void): () => void {
    return subscribe(this.listListeners, listener);
  }

  subscribeState(listener: () => void): () => void {
    return subscribe(this.stateListeners, listener);
  }

  subscribeQueue(listener: () => void): () => void {
    return subscribe(this.queueListeners, listener);
  }

  /** Every change, with the ids of the rows it changed (the streaming driver). */
  subscribeChanges(listener: (ids: readonly string[]) => void): () => void {
    return subscribe(this.changeListeners, listener);
  }

  subscribeRow(id: string, listener: () => void): () => void {
    let listeners = this.rowListeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.rowListeners.set(id, listeners);
    }
    const set = listeners;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.rowListeners.delete(id);
      }
    };
  }

  private applyOne(method: string, params: Record<string, unknown>, batch: Batch): void {
    const ts = numberOr(params.ts);
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    switch (method) {
      case 'turn/started':
        this.turn = { ...IDLE, running: true, turnId, startedAt: ts };
        batch.state = true;
        batch.list = true;
        break;
      case 'turn/completed':
        this.onTurnCompleted(turnId, params, batch);
        break;
      case 'turn/retrying': {
        const attempt = numberOr(params.attempt);
        const max = numberOr(params.maxAttempts);
        if (attempt !== undefined && max !== undefined) {
          this.turn = { ...this.turn, retry: { attempt, max } };
          batch.state = true;
        }
        break;
      }
      case 'turn/usage': {
        const usage = usageOf(params.usage);
        if (usage !== undefined) {
          this.turn = { ...this.turn, usage, retry: undefined };
          batch.state = true;
        }
        break;
      }
      case 'item/started':
      case 'item/updated':
      case 'item/completed':
        if (isItem(params.item)) {
          this.upsert(params.item, turnId, ts, method === 'item/completed', batch);
        }
        break;
      case 'item/agentMessage/delta':
      case 'item/reasoning/delta':
        this.appendDelta(params, batch);
        break;
      // A subagent run's state (T31): its card follows it, background runs after their call.
      case 'subagent/started':
      case 'subagent/progress':
      case 'subagent/completed':
        this.onSubagent(params, batch);
        break;
      case 'session/queueChanged':
        this.queueItems = Array.isArray(params.items) ? params.items.flatMap(queueItemOf) : [];
        batch.queue = true;
        break;
      case 'session/uncertain':
        this.onUncertain(params, batch);
        break;
      // Lost notifications, or the conversation continues on another branch (T28): the rows,
      // task list and branch points are loaded again.
      case 'session/resync':
      case 'session/branchChanged':
        this.reload = true;
        batch.state = true;
        break;
      default:
        if (!this.harness.apply(method, params) && !this.branches.apply(method, params)) {
          this.usage.apply(method, params);
        }
        break;
    }
  }

  private onSubagent(params: Record<string, unknown>, batch: Batch): void {
    const id = typeof params.itemId === 'string' ? params.itemId : undefined;
    const row = id === undefined ? undefined : this.rows.get(id);
    const state = subagentStateOf(params.subagent);
    if (id === undefined || row?.kind !== 'item' || row.item.type !== 'subagent' || !state) {
      return;
    }
    this.rows.set(id, { ...row, item: { ...row.item, subagent: state } });
    batch.changed.add(id);
  }

  private onTurnCompleted(turnId: string, params: Record<string, unknown>, batch: Batch): void {
    if (this.turn.running && (this.turn.turnId === turnId || turnId === '')) {
      this.turn = IDLE;
      batch.state = true;
      batch.list = true;
    }
    if (params.status === 'failed') {
      const id = `error:${turnId}`;
      if (!this.rows.has(id)) {
        this.rows.set(id, {
          kind: 'error',
          id,
          turnId,
          errorKind: errorKindOf(params.errorKind),
          message: typeof params.errorMessage === 'string' ? params.errorMessage : '',
          retryable: params.retryable !== false,
        });
        this.order.push(id);
        batch.changed.add(id);
        batch.list = true;
      }
    }
  }

  private onUncertain(params: Record<string, unknown>, batch: Batch): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    if (turnId === undefined) {
      return;
    }
    const id = `uncertain:${turnId}`;
    if (!this.rows.has(id)) {
      this.rows.set(id, { kind: 'uncertain', id, turnId });
      this.order.push(id);
      batch.changed.add(id);
      batch.list = true;
    }
    if (this.turn.turnId === turnId) {
      this.turn = IDLE;
      batch.state = true;
    }
  }

  private upsert(
    item: Item,
    turnId: string,
    ts: number | undefined,
    completed: boolean,
    batch: Batch,
  ): void {
    const existing = this.rows.get(item.itemId);
    if (existing?.kind === 'item') {
      this.rows.set(item.itemId, {
        ...existing,
        item: keepFinishedRun(existing.item, item),
        ...(completed && ts !== undefined ? { endedAt: ts } : {}),
      });
      batch.changed.add(item.itemId);
    } else {
      const row: TranscriptRow = {
        kind: 'item',
        id: item.itemId,
        turnId,
        item,
        ...(ts === undefined ? {} : { startedAt: ts }),
        ...(completed && ts !== undefined ? { endedAt: ts } : {}),
      };
      this.rows.set(item.itemId, row);
      batch.changed.add(item.itemId);
      batch.list = true;
      const echo = item.type === 'userMessage' ? this.optimisticFor(turnId, item.text) : undefined;
      if (echo === undefined) {
        this.order.push(item.itemId);
      } else {
        // Core's message takes the optimistic row's place.
        this.order = this.order.map((id) => (id === echo ? item.itemId : id));
        this.rows.delete(echo);
        batch.changed.add(echo);
      }
    }
    this.trackTurn(item, batch);
  }

  /** Open tools and compaction of the running turn (the working row). */
  private trackTurn(item: Item, batch: Batch): void {
    if (!this.turn.running) {
      return;
    }
    const open = item.status === 'inProgress';
    if (isTool(item)) {
      const has = this.turn.openTools.includes(item.itemId);
      if (open !== has) {
        this.turn = {
          ...this.turn,
          openTools: open
            ? [...this.turn.openTools, item.itemId]
            : this.turn.openTools.filter((id) => id !== item.itemId),
          retry: undefined,
        };
        batch.state = true;
      }
    } else if (item.type === 'contextCompaction' && this.turn.compacting !== open) {
      this.turn = { ...this.turn, compacting: open };
      batch.state = true;
    }
  }

  private appendDelta(params: Record<string, unknown>, batch: Batch): void {
    const { itemId, delta } = params;
    if (typeof itemId !== 'string' || typeof delta !== 'string') {
      return;
    }
    const row = this.rows.get(itemId);
    if (row?.kind !== 'item' || !('text' in row.item)) {
      return;
    }
    this.rows.set(itemId, { ...row, item: { ...row.item, text: row.item.text + delta } });
    batch.changed.add(itemId);
    if (this.turn.retry !== undefined) {
      this.turn = { ...this.turn, retry: undefined };
      batch.state = true;
    }
  }

  /** The optimistic row Core's user message of `turnId` confirms. */
  private optimisticFor(turnId: string, text: string): string | undefined {
    let unconfirmed: string | undefined;
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row?.kind !== 'optimistic') {
        continue;
      }
      if (row.turnId === turnId) {
        return id;
      }
      // The event can overtake the prompt's reply. A previous failed send with identical
      // text is still the user's to resend.
      if (row.state === 'sending' && row.turnId === undefined && row.input.text === text) {
        unconfirmed ??= id;
      }
    }
    return unconfirmed;
  }

  private update(id: string, row: TranscriptRow): void {
    const batch = new Batch();
    this.rows.set(id, row);
    batch.changed.add(id);
    this.finish(batch);
  }

  private remove(id: string): void {
    if (!this.rows.delete(id)) {
      return;
    }
    const batch = new Batch();
    this.order = this.order.filter((other) => other !== id);
    batch.changed.add(id);
    batch.list = true;
    this.finish(batch);
  }

  /** Recomputes the shown rows (groups, working row) after the order changed. */
  private relist(batch: Batch): void {
    const next: string[] = [];
    const groups = new Set<string>();
    let members: string[] = [];
    let groupTurn: string | undefined;
    const flush = (): void => {
      const first = members[0];
      if (first === undefined) {
        return;
      }
      const id = `group:${first}`;
      const previous = this.rows.get(id);
      if (previous?.kind !== 'group' || !sameList(previous.members, members)) {
        this.rows.set(id, { kind: 'group', id, members });
        batch.changed.add(id);
      }
      groups.add(id);
      next.push(id);
      members = [];
    };
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row?.kind === 'item' && isGrouped(row.item)) {
        if (groupTurn !== row.turnId) flush();
        groupTurn = row.turnId;
        members.push(id);
      } else {
        flush();
        next.push(id);
      }
    }
    flush();
    next.push(...this.approvalIds);
    if (this.turn.running) {
      next.push(WORKING_ROW);
      if (!this.rows.has(WORKING_ROW)) {
        this.rows.set(WORKING_ROW, { kind: 'working', id: WORKING_ROW });
      }
    }
    for (const id of this.display) {
      if (id.startsWith('group:') && !groups.has(id)) {
        this.rows.delete(id);
      }
    }
    if (!sameList(this.display, next)) {
      this.display = next;
      batch.listChanged = true;
    }
  }

  private finish(batch: Batch): void {
    if (batch.list) {
      this.relist(batch);
      this.turnStarts = undefined;
    }
    if (batch.listChanged) {
      emit(this.listListeners);
    }
    for (const id of batch.changed) {
      emit(this.rowListeners.get(id));
    }
    if (batch.state) {
      emit(this.stateListeners);
      emit(this.rowListeners.get(WORKING_ROW));
    }
    if (batch.queue) {
      emit(this.queueListeners);
    }
    if (batch.changed.size > 0) {
      const ids = [...batch.changed];
      for (const listener of [...this.changeListeners]) {
        listener(ids);
      }
    }
  }
}

/** What one change touched. */
class Batch {
  readonly changed = new Set<string>();
  /** The order may have changed: recompute the shown rows. */
  list = false;
  /** The shown rows changed. */
  listChanged = false;
  state = false;
  queue = false;
}

function emit(listeners: Set<() => void> | undefined): void {
  for (const listener of [...(listeners ?? [])]) {
    listener();
  }
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
