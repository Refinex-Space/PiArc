// Plan mode (architecture section 6.5, T26). Core owns the mode and enforces it at the
// permission gate (step 5: writes and non-read-only commands are refused); the tool list never
// changes. This module keeps the branch's record of the mode and tells the model:
//
// - every switch is a `piarc.permissionMode` entry, projected as a `permissionModeChanged`
//   item (the mode menu through `session/setPermissionMode`; EnterPlanMode and an approved
//   plan through the `mode` of Core's `policy/evaluate` answer);
// - turning plan mode on or off queues a reminder (key `mode`); switching back before the
//   model heard of it withdraws it;
// - `EnterPlanMode` takes no arguments (Core switches the mode when it allows the call);
//   `ExitPlanMode` runs only after the user approved its plan card: it records the plan as the
//   custom entry `piarc.plan` and sends `harness/plan`.
//
// `currentPlan` is the injection interface T27 uses to give the plan back after compaction.
import {
  defineTool,
  type SessionEntry,
  type SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PermissionMode, PlanRecord } from '@piarc/protocol';
import { isPermissionMode } from '@piarc/protocol';
import { Type } from 'typebox';

import { isObject } from '../runtime/items.js';
import { MODE_ENTRY, modeItem, modeRecord } from '../runtime/permission-mode.js';
import type { ProjectionSink } from '../runtime/projector.js';
import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import { PLAN_ON, planOff } from './prompts/notices.js';
import type { Reminders } from './reminders.js';

export { PLAN_ON, planOff };

/** Custom entry of an approved plan. */
export const PLAN_ENTRY = 'piarc.plan';

/** Reminder key of the mode notices. */
export const MODE_REMINDER = 'mode';

/** The last plan the user approved on the branch. */
export function currentPlan(entries: readonly SessionEntry[]): PlanRecord | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'custom' || entry.customType !== PLAN_ENTRY || !isObject(entry.data)) {
      continue;
    }
    const { plan, toolCallId, mode } = entry.data;
    if (typeof plan === 'string' && typeof toolCallId === 'string' && isPermissionMode(mode)) {
      return { plan, toolCallId, entryId: entry.id, mode };
    }
  }
  return undefined;
}

/** One session's plan mode record. */
export class PlanMode {
  readonly #manager: SessionManager;
  readonly #sink: ProjectionSink;
  readonly #reminders: Reminders;
  readonly #activeTurn: () => string | undefined;
  /** The mode last recorded on the branch. */
  #mode: PermissionMode | undefined;
  /** Whether the model was last told that plan mode is on. */
  #told: boolean;

  constructor(options: {
    manager: SessionManager;
    sink: ProjectionSink;
    reminders: Reminders;
    activeTurn: () => string | undefined;
  }) {
    this.#manager = options.manager;
    this.#sink = options.sink;
    this.#reminders = options.reminders;
    this.#activeTurn = options.activeTurn;
    const last = this.#manager.getBranch().findLast((entry) => modeRecord(entry) !== undefined);
    this.#mode = last === undefined ? undefined : modeRecord(last)?.mode;
    this.#told = this.#mode === 'plan';
  }

  /** The mode last recorded on the branch. */
  get mode(): PermissionMode | undefined {
    return this.#mode;
  }

  /** Records a switch on the branch and in the transcript, and tells the model about plan
   * mode starting or ending. */
  record(mode: PermissionMode): void {
    const turnId = this.#activeTurn();
    const itemId = this.#manager.appendCustomEntry(MODE_ENTRY, { mode, turnId });
    this.#mode = mode;
    this.#sink.event('item/completed', { turnId: turnId ?? itemId, item: modeItem(itemId, mode) });
    const plan = mode === 'plan';
    if (plan === this.#told) {
      this.#reminders.withdraw(MODE_REMINDER);
      return;
    }
    this.#reminders.enqueue(
      MODE_REMINDER,
      { type: 'planMode', source: mode, text: plan ? PLAN_ON : planOff(mode) },
      () => {
        this.#told = plan;
      },
    );
  }

  /** A tool result tells the model the current mode itself: no reminder is needed. */
  acknowledge(): void {
    this.#reminders.withdraw(MODE_REMINDER);
    this.#told = this.#mode === 'plan';
  }

  /** Records the approved plan and reports it. */
  approve(toolCallId: string, plan: string): PlanRecord {
    const mode = this.#mode ?? 'default';
    const entryId = this.#manager.appendCustomEntry(PLAN_ENTRY, { plan, toolCallId, mode });
    const record: PlanRecord = { plan, toolCallId, entryId, mode };
    this.#sink.event('harness/plan', { ...record, plan: plan.toWellFormed() });
    return record;
  }
}

const enterSchema = Type.Object({});

const exitSchema = Type.Object({
  plan: Type.String({
    minLength: 1,
    description:
      'The complete plan in Markdown: the steps in order, the files involved and how the ' +
      'result will be checked.',
  }),
});

export function createEnterPlanModeTool(
  presentation: ToolPresentation,
  planMode: PlanMode,
): ToolDefinition {
  return defineTool<typeof enterSchema, undefined>({
    ...presentationOf(presentation),
    parameters: enterSchema,
    execute() {
      // Core switched the mode when it allowed this call (or it was on already); the result
      // is the notice.
      planMode.acknowledge();
      return Promise.resolve({ content: [{ type: 'text', text: PLAN_ON }], details: undefined });
    },
  });
}

export function createExitPlanModeTool(
  presentation: ToolPresentation,
  planMode: PlanMode,
): ToolDefinition {
  return defineTool<typeof exitSchema, PlanRecord>({
    ...presentationOf(presentation),
    parameters: exitSchema,
    execute(toolCallId, params) {
      // Reached only after the user approved the plan card: Core already switched the mode.
      const record = planMode.approve(toolCallId, params.plan);
      planMode.acknowledge();
      const text =
        `The user approved the plan. ${planOff(record.mode)} ` +
        'Carry out the plan now, keeping the user informed of progress.';
      return Promise.resolve({ content: [{ type: 'text', text }], details: record });
    },
  });
}
