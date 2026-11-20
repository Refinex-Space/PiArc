// Types of the session registry (session-registry.ts): its options, the tool backends and what
// it keeps per hosted session.
import type { AgentSessionEvent, AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import type { InputAccepted } from '@piarc/protocol';

import type { SessionHooks } from '../harness/hooks.js';
import type { HostToolCapabilities, SessionHarness } from '../harness/session-harness.js';
import type { SessionMemory } from '../harness/session-memory.js';
import type { ToolBatches } from '../harness/tool-batches.js';
import type { ToolResultLimits } from '../harness/tool-results.js';
import type { CoreIo, ToolProfile } from '../tools/index.js';
import type { CoreBridge } from './core-bridge.js';
import type { PreparedInput } from './input.js';
import type { Projector, ProjectionSink } from './projector.js';
import type { InputQueue } from './queue.js';
import type { Workspace } from './workspace.js';

/** Emits the projected notifications of one session. */
export type SessionSinkFactory = (sessionId: string) => ProjectionSink;

/**
 * Which tools sessions get. `core`: the canonical tools of `profile` with their I/O delegated to
 * Core (the only mode Core starts the Agent Host in). `pi-native`: Pi's own tools with local I/O,
 * under their own names; only the behavior comparison test uses it (`--pi-native-tools`).
 */
export type ToolBackend =
  | {
      readonly kind: 'core';
      readonly bridge: CoreBridge;
      readonly profile: ToolProfile;
      readonly ioFor: (sessionId: string) => CoreIo;
    }
  | { readonly kind: 'pi-native' };

/** Pi's tools the `pi-native` backend activates: the counterparts of the canonical six. */
export const PI_NATIVE_TOOLS = ['read', 'write', 'edit', 'bash', 'find', 'grep'];

export interface RegistryOptions {
  readonly workspace: Workspace;
  readonly tools: ToolBackend;
  /** Available when Core negotiated session memory in the handshake. */
  readonly memoryBridge?: CoreBridge;
  readonly sinkFor: SessionSinkFactory;
  /**
   * Asks Core whether `cwd` is a trusted project (`askCoreTrust`); must resolve `false` on any
   * failure. Answers Pi's project trust hook (`takeOverProjectTrust`).
   */
  readonly isTrusted: (cwd: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  /**
   * Test only (`--test-record-events`): receives every raw Pi event of every session, and the
   * registry's own steps that shape the projection (a turn accepted, an abort, a queued input),
   * so a recording replays exactly.
   */
  readonly onPiEvent?: (sessionId: string, event: AgentSessionEvent | RecordedControl) => void;
  /** A session was closed: its replay buffer can go. */
  readonly onClosed?: (sessionId: string) => void;
  /** How much of a tool result reaches the model; `TOOL_RESULT_LIMITS` when absent. */
  readonly toolResultLimits?: ToolResultLimits;
  /** Core runs hooks (`hooks` capability): sessions report their events over it. */
  readonly hooksBridge?: CoreBridge;
  /** What Core enabled for the host tools (`planMode`, `todo`, `ask`; T26). */
  readonly hostTools?: HostToolCapabilities;
}

/** What a turn runs: an input, or a compaction (`/compact [focus]`). */
export type Job =
  | { readonly kind: 'prompt'; readonly prepared: PreparedInput }
  | { readonly kind: 'compact'; readonly instructions: string | undefined };

/** A registry step in a recording (`onPiEvent`). */
export type RecordedControl =
  | { readonly control: 'beginTurn'; readonly turnId: string }
  | { readonly control: 'markAborting' }
  | { readonly control: 'takeFollowUp' }
  | { readonly control: 'steer' | 'followUp'; readonly text: string };

export interface HostedSession {
  readonly runtime: AgentSessionRuntime;
  readonly projector: Projector;
  readonly memory: SessionMemory;
  readonly queue: InputQueue;
  readonly batches: ToolBatches;
  readonly toCanonical: (tool: string) => string;
  /** Hook events reported to Core (absent without the `hooks` capability). */
  readonly hooks: SessionHooks | undefined;
  /** Host tools, plan mode and reminders (T26). */
  readonly harness: SessionHarness;
  unsubscribe: () => void;
  /** Idempotency keys of accepted prompts → their turn ids. */
  readonly prompts: Map<string, string>;
  /** Idempotency keys of accepted steering and follow-up inputs → their answers. */
  readonly inputs: Map<string, InputAccepted>;
  /** Idempotency keys of requests whose attachments are still being read → their answer. */
  readonly preparing: Map<string, Promise<unknown>>;
  /** Inputs given to Pi whose user message has not started yet (input.ts records). */
  readonly delivering: PreparedInput[];
  /** The running turn and the leaf before it: where a rewind continues (T28). */
  turnFrom?: { readonly turnId: string; readonly from: string | null };
  changingModel: boolean;
  closed: boolean;
}
