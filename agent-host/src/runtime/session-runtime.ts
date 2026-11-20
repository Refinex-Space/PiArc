// The Pi runtime of one session: settings, resources, tools and the Harness Kit extensions,
// for a main session (`SessionRegistry.#open`) and a subagent's child session
// (`runtime/subagents.ts`). Split out of the registry (T31, file length).
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createMcpExtension,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { IDENTITY } from '../harness/prompts/system.js';
import { policyGate } from '../harness/policy.js';
import type { SessionHarness } from '../harness/session-harness.js';
import type { SessionHooks } from '../harness/hooks.js';
import type { SessionMemory } from '../harness/session-memory.js';
import { interruptedContext } from '../harness/interruption.js';
import { takeOverProjectTrust, type TrustTakeover } from '../harness/project-trust.js';
import type { ToolBatches } from '../harness/tool-batches.js';
import { createToolResultBudget, TOOL_RESULT_LIMITS } from '../harness/tool-results.js';
import { toolOptions } from '../tools/index.js';
import type { ToolProfile } from '../tools/profile.js';
import { onlyConservative, scheduled, shellsFor } from './session-helpers.js';
import { PI_NATIVE_TOOLS, type RegistryOptions } from './session-types.js';

/** A child session's tool set (T31): the canonical names it may use, and the gate. */
export interface ChildTools {
  /** Applied to each custom tool (hides the others from requests). */
  readonly wrap: (tool: ToolDefinition) => ToolDefinition;
  /** Runs before the permission gate. */
  readonly gate: ExtensionFactory;
}

export interface RuntimeSpec {
  readonly options: RegistryOptions;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly profile: ToolProfile;
  readonly conservative: boolean;
  readonly canonical: (tool: string) => string;
  readonly batches: ToolBatches;
  readonly harness: SessionHarness;
  readonly memory: SessionMemory;
  readonly hooks: SessionHooks | undefined;
  /** The model to start on; Pi's choice (the branch's, else its default) when absent. */
  readonly model: Model<Api> | undefined;
  /** A refused call (its item shows `declined`). */
  readonly declined: (toolCallId: string) => void;
  readonly log: (line: string) => void;
  /** Set for a subagent's session. */
  readonly child?: ChildTools;
}

/** Creates the Pi runtime of `spec`; `trust()` answers whether the project was trusted. */
export async function createSessionRuntime(
  spec: RuntimeSpec,
): Promise<{ runtime: AgentSessionRuntime; trusted: () => boolean }> {
  const { options, harness, memory, hooks, canonical, batches, profile } = spec;
  const { tools, workspace } = options;
  let trust: TrustTakeover | undefined;
  const factory: CreateAgentSessionRuntimeFactory = async (target) => {
    // In-memory overrides (no silent provider retries, the compaction threshold) are
    // applied by `harness.compaction` once the session exists and before every run.
    const settingsManager = SettingsManager.create(target.cwd, target.agentDir, {
      projectTrusted: false,
    });
    const sessionId = target.sessionManager.getSessionId();
    const io = tools.kind === 'core' ? tools.ioFor(sessionId) : undefined;
    // Which command tools the session gets depends on the shells Core found (T17).
    let sessionTools =
      tools.kind === 'core' && io !== undefined
        ? scheduled(
            onlyConservative(
              toolOptions(
                io,
                profile,
                await shellsFor(io, options.log),
                settingsManager.getImageAutoResize(),
                options.memoryBridge ? memory.searched : undefined,
                harness.tools(),
              ),
              spec.conservative,
              canonical,
            ),
            batches,
          )
        : { tools: PI_NATIVE_TOOLS };
    const { child } = spec;
    if (child !== undefined && 'customTools' in sessionTools) {
      sessionTools = { ...sessionTools, customTools: sessionTools.customTools.map(child.wrap) };
    }
    // Long tool results go to the session's temporary directory (Harness Kit).
    const budget =
      io === undefined
        ? []
        : [
            createToolResultBudget({
              io,
              isExempt: (tool) => canonical(tool) === 'Read',
              limits: options.toolResultLimits ?? TOOL_RESULT_LIMITS,
            }),
          ];
    // Project-level Pi resources (`.pi/settings.json`, `.pi/mcp.json`, extensions) load
    // only for directories Core trusts: nothing project-level is read until the takeover
    // hook has Core's answer.
    trust = takeOverProjectTrust(target.cwd, options.isTrusted);
    const services = await createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      modelRuntime: workspace.modelRuntime,
      settingsManager,
      resourceLoaderReloadOptions: trust.reloadOptions,
      resourceLoaderOptions: {
        // PiArc assembles project context itself (T22).
        noContextFiles: true,
        systemPromptOverride: () => IDENTITY,
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          ...(child === undefined ? [] : [child.gate]),
          ...(tools.kind === 'core'
            ? [
                policyGate(
                  tools.bridge,
                  sessionId,
                  canonical,
                  spec.declined,
                  spec.log,
                  hooks?.notes,
                  (mode) => {
                    harness.recordMode(mode);
                  },
                ),
              ]
            : []),
          createMcpExtension(),
          ...budget,
          // After the budget: hooks see (and may replace) what the model would read.
          ...(hooks === undefined ? [] : [hooks.extension]),
          interruptedContext,
          memory.extension,
          ...(tools.kind === 'core' ? harness.extensions() : []),
        ],
        // Extension tools (MCP, project extensions) run under the same batches.
        extensionsOverride: (result) => batches.wrapExtensions(result),
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      ...sessionTools,
      ...(target.sessionStartEvent === undefined
        ? {}
        : { sessionStartEvent: target.sessionStartEvent }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: spec.cwd,
    agentDir: workspace.agentDir,
    sessionManager: spec.manager,
  });
  return { runtime, trusted: () => trust?.trusted() ?? false };
}
