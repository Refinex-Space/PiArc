// The per-session Harness Kit parts a session opens with: the auxiliary model channel, the
// session harness (host tools, reminders, compaction), session memory and Core's hooks. Split
// out of `SessionRegistry.#open` (R3, file length); the registry wires them into Pi.

import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { McpServerDefinition } from '@piarc/protocol';

import { AUXILIARY_USAGE_ENTRY, AuxiliaryModel } from '../harness/auxiliary.js';
import { SessionHooks } from '../harness/hooks.js';
import { memoryReader } from '../harness/memory-io.js';
import { preflightInput } from '../harness/policy.js';
import { SessionHarness } from '../harness/session-harness.js';
import { SessionMemory } from '../harness/session-memory.js';
import { SessionSkills } from '../harness/skills/session-skills.js';
import type { Persona } from '../harness/prompts/system.js';
import type { AgentToolHost } from '../harness/subagents/agent-tool.js';
import { McpSession } from '../mcp/session.js';
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
  /** The session's `Agent` tool (T31), when it may start subagents. */
  readonly agents?: AgentToolHost;
  /** Set for a subagent's session (T31): its identity and context choice; the MCP servers its
   * definition defines inline (T36). */
  readonly child?: {
    readonly persona: Persona;
    readonly mcpInline?: readonly McpServerDefinition[];
  };
}

export interface SessionParts {
  readonly harness: SessionHarness;
  readonly memory: SessionMemory;
  readonly hooks: SessionHooks | undefined;
  /** The session's part of the workspace MCP pool (T36). */
  readonly mcp: McpSession | undefined;
  /** The session's skills and output style (T37); read the catalog before the tools. */
  readonly skills: SessionSkills | undefined;
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
    ...(input.agents === undefined ? {} : { agents: input.agents }),
  });
  const memory = new SessionMemory(
    manager,
    cwd,
    tools.kind === 'core' ? profile : undefined,
    options.memoryBridge ? memoryReader(options.memoryBridge, manager.getSessionId()) : undefined,
    toCanonical,
    harness.reminders,
    input.child?.persona,
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
          ...(input.child === undefined ? {} : { subagent: true }),
        });
  harness.connect(memory, hooks);
  const pool = tools.kind === 'core' ? options.mcp : undefined;
  const mcp =
    pool === undefined
      ? undefined
      : new McpSession({
          pool,
          sessionId: manager.getSessionId(),
          cwd,
          reminders: harness.reminders,
          log: sessionLog,
          ...(input.child?.mcpInline === undefined ? {} : { inline: input.child.mcpInline }),
        });
  if (mcp !== undefined) memory.mcpSection = () => mcp.systemSection();
  const skills =
    tools.kind === 'core' && options.hostTools?.skills === true
      ? new SessionSkills({
          sessionId: manager.getSessionId(),
          manager,
          bridge: options.hostTools.bridge,
          reminders: harness.reminders,
          canonical: toCanonical,
          cwd,
          log: sessionLog,
        })
      : undefined;
  if (skills !== undefined) {
    harness.skills = skills;
    memory.skillSections = (signal) => skills.sections(signal);
  }
  return { harness, memory, hooks, mcp, skills };
}
