// The per-session Harness Kit parts a session opens with: the auxiliary model channel, the
// session harness (host tools, reminders, compaction), session memory and Core's hooks. Split
// out of `SessionRegistry.#open` (R3, file length); the registry wires them into Pi.

import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

import { AUXILIARY_USAGE_ENTRY, AuxiliaryModel } from '../harness/auxiliary.js';
import { SessionHooks } from '../harness/hooks.js';
import { memoryReader } from '../harness/memory-io.js';
import { preflightInput } from '../harness/policy.js';
import { SessionHarness } from '../harness/session-harness.js';
import { SessionMemory } from '../harness/session-memory.js';
import type { ToolProfile } from '../tools/profile.js';
import type { Projector } from './projector.js';
import type { RegistryOptions } from './session-types.js';

export interface SessionPartsInput {
  readonly options: RegistryOptions;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly source: 'startup' | 'resume' | 'fork' | 'branch';
  readonly profile: ToolProfile;
  readonly conservative: boolean;
  readonly canonical: (tool: string) => string;
  /** Filled once the runtime exists; the parts read it lazily. */
  readonly opened: { session?: AgentSession; projector?: Projector };
  readonly log: (line: string) => void;
}

export interface SessionParts {
  readonly harness: SessionHarness;
  readonly memory: SessionMemory;
  readonly hooks: SessionHooks | undefined;
}

/** Creates and connects the parts of one session. */
export function sessionParts(input: SessionPartsInput): SessionParts {
  const { options, manager, cwd, source, profile, conservative, opened } = input;
  const { tools, workspace } = options;
  const toCanonical = input.canonical;
  const sessionLog = input.log;
  const auxiliary = new AuxiliaryModel({
    runtime: workspace.modelRuntime,
    preferences: workspace.preferences,
    session: () => opened.session,
    onUsage: (usage, used, purpose) => {
      opened.projector?.auxiliaryUsage(usage);
      manager.appendCustomEntry(AUXILIARY_USAGE_ENTRY, { purpose, model: used, usage });
    },
    log: sessionLog,
  });
  const harness = new SessionHarness({
    sessionId: manager.getSessionId(),
    manager,
    sink: options.sinkFor(manager.getSessionId()),
    profile,
    auxiliary,
    conservative,
    canonical: toCanonical,
    activeTurn: () => opened.projector?.activeTurnId,
    core: tools.kind === 'core' ? options.hostTools : undefined,
    cwd,
    session: () => opened.session,
    io: tools.kind === 'core' ? tools.ioFor(manager.getSessionId()) : undefined,
    appended: (message) => opened.projector?.reminder(message),
    log: sessionLog,
    contextWindow: (model) => workspace.preferences.contextWindow(model),
  });
  const memory = new SessionMemory(
    manager,
    cwd,
    tools.kind === 'core' ? profile : undefined,
    options.memoryBridge ? memoryReader(options.memoryBridge, manager.getSessionId()) : undefined,
    toCanonical,
    harness.reminders,
  );
  const hooksBridge = tools.kind === 'core' ? options.hooksBridge : undefined;
  const hooks =
    hooksBridge === undefined
      ? undefined
      : new SessionHooks({
          bridge: hooksBridge,
          sessionId: manager.getSessionId(),
          cwd,
          source,
          canonical: toCanonical,
          transcript: () => opened.session?.sessionFile ?? manager.getSessionFile(),
          reminders: harness.reminders,
          hookInput: (tool, input) => {
            const resolved = preflightInput(tool, input, cwd);
            delete resolved.readPathCandidates;
            return resolved;
          },
          log: sessionLog,
        });
  harness.connect(memory, hooks);
  return { harness, memory, hooks };
}
