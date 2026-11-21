// Which tools a subagent gets (T31, architecture section 6.4), in this order:
//
// 1. the parent session's current tools (whole-tool deny rules already removed them there);
// 2. the definition's `tools` list, when it has one;
// 3. minus `disallowedTools` (a `Tool(specifier)` entry removes the whole tool; Core reduced
//    the specifier), which wins over `tools`;
// 4. minus the tools that talk to the user or change the main session's mode
//    (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `SuggestNextSteps`);
// 5. minus `Agent` at the depth limit.
//
// The child session registers every tool, and each of its tools hides the ones outside the set
// from the model's requests (Pi 1.5.2's `prepareLoadout` `hiddenDeclarations`): hidden tools
// stay callable, so a call to one reaches the `tool_call` gate, which refuses it. Removing them
// with `setActiveTools` instead would let Pi answer such a call with "not found" before any
// gate ran, and tools that register later (MCP) would start active.
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { mcpNamespace } from '@earendil-works/pi-mcp';
import type { AgentDefinition } from '@piarc/protocol';

import { toolNotAvailable } from '../prompts/subagents.js';

/** Tools no subagent gets: they talk to the user or switch the main session's mode. */
export const PARENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'SuggestNextSteps',
]);

/**
 * The tool set plus the tools of the subagent's own inline MCP servers (T36), which register
 * only once the subagent's session connects them: `mcp__<server>__…` of those servers, unless
 * `disallowedTools` names the tool or the server (`mcp__<server>`).
 */
class WithInlineServers extends Set<string> {
  readonly #prefixes: readonly string[];
  readonly #disallowed: ReadonlySet<string>;

  constructor(
    tools: Iterable<string>,
    prefixes: readonly string[],
    disallowed: ReadonlySet<string>,
  ) {
    super(tools);
    this.#prefixes = prefixes;
    this.#disallowed = disallowed;
  }

  override has(tool: string): boolean {
    if (super.has(tool)) return true;
    const prefix = this.#prefixes.find((p) => tool.startsWith(p));
    return (
      prefix !== undefined &&
      !this.#disallowed.has(tool) &&
      !this.#disallowed.has(prefix.slice(0, -2))
    );
  }
}

/** The canonical tools a subagent of `definition` may use at `depth` (1 = a main session's). */
export function allowedTools(
  parentTools: readonly string[],
  definition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'mcpInline'>,
  depth: number,
  maxDepth: number,
): Set<string> {
  let allowed = [...parentTools];
  if (definition.tools !== undefined) {
    const listed = new Set(definition.tools);
    allowed = allowed.filter((tool) => listed.has(tool));
  }
  const disallowed = new Set(definition.disallowedTools ?? []);
  const tools = allowed.filter(
    (tool) =>
      !disallowed.has(tool) &&
      !PARENT_ONLY_TOOLS.has(tool) &&
      !(tool === 'Agent' && depth >= maxDepth),
  );
  const inline = (definition.mcpInline ?? [])
    .filter((server) => server.availability === 'ready')
    .map((server) => `${mcpNamespace(server.name)}__`);
  return inline.length === 0 ? new Set(tools) : new WithInlineServers(tools, inline, disallowed);
}

/** `tool` hiding every declared tool outside `allowed` (canonical names) from requests. */
export function hidingOthers(
  tool: ToolDefinition,
  allowed: ReadonlySet<string>,
  canonical: (name: string) => string,
): ToolDefinition {
  return {
    ...tool,
    prepareLoadout: (loadout) => ({
      hiddenDeclarations: loadout.declared
        .map((declared) => declared.name)
        .filter((name) => !allowed.has(canonical(name))),
    }),
  };
}

/** The gate: a call to a tool outside the set is refused before it runs. Registered first. */
export function toolGate(
  allowed: ReadonlySet<string>,
  canonical: (name: string) => string,
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      const tool = canonical(event.toolName);
      return allowed.has(tool) ? undefined : { block: true, reason: toolNotAvailable(tool) };
    });
  };
}
