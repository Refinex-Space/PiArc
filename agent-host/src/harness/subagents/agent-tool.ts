// The `Agent` tool (T31, architecture section 6.4): the model hands a task to a subagent. The
// parameters follow Claude Code's tool (as T30's L3 recordings show its structure); the
// description and the parameter texts are PiArc's. The run itself is the runtime's
// (`runtime/subagents.ts`): this module only validates the call and forwards it.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentDefinition, SubagentState } from '@piarc/protocol';
import { Type, type Static } from 'typebox';

import { isObject } from '../../runtime/items.js';
import { presentationOf } from '../../tools/presentation.js';
import type { ToolPresentation } from '../../tools/profile.js';
import { withTypes } from '../prompts/subagents.js';
import { DEFAULT_TYPE } from './definitions.js';

const MODEL_CHOICES = ['inherit', 'fast', 'balanced', 'strong', 'haiku', 'sonnet', 'opus'] as const;
const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * A string parameter limited to `values`, written as `{ type: "string", enum }` rather than an
 * `anyOf` of constants: providers such as Google reject `anyOf`/`const` in tool schemas (Pi's
 * `StringEnum` makes the same shape), and Claude Code's tool has this shape too.
 */
function stringEnum<const T extends readonly string[]>(
  values: T,
  options: { readonly description: string },
) {
  return Type.Unsafe<T[number]>({ type: 'string', enum: [...values], ...options });
}

const agentSchema = Type.Object({
  description: Type.String({ description: 'A short title of the task, in a few words.' }),
  prompt: Type.String({
    description: 'The task, with everything the subagent needs to carry it out on its own.',
  }),
  subagent_type: Type.Optional(
    Type.String({ description: 'The kind of subagent to start; general-purpose when omitted.' }),
  ),
  model: Type.Optional(
    stringEnum(MODEL_CHOICES, {
      description:
        "Another model for this run: a tier of the user's model table, or inherit (this " +
        "session's model). The type's own choice when omitted.",
    }),
  ),
  effort: Type.Optional(
    stringEnum(EFFORT_CHOICES, {
      description: "Reasoning effort for this run; the model's default when omitted.",
    }),
  ),
  isolation: Type.Optional(
    Type.Literal('worktree', {
      description: 'Run in a separate git worktree. Not available yet: such a call fails.',
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'Return at once and get the report later as a notice, instead of waiting for it.',
    }),
  ),
});

/** One `Agent` call, as the runtime receives it. */
export interface AgentCall {
  readonly description: string;
  readonly prompt: string;
  readonly type: string;
  readonly model?: string;
  readonly effort?: string;
  readonly isolation?: string;
  readonly background?: boolean;
}

/** The result details: the run's state, which the `subagent` item shows. */
export interface AgentDetails {
  readonly subagent?: SubagentState;
}

/** What runs the calls of one session's `Agent` tool. */
export interface AgentToolHost {
  /** The types the description lists. */
  readonly types: readonly AgentDefinition[];
  run(
    toolCallId: string,
    call: AgentCall,
    signal: AbortSignal | undefined,
    progress: (state: SubagentState, activity: string) => void,
  ): Promise<{ text: string; isError: boolean; details: AgentDetails }>;
}

export function createAgentTool(
  presentation: ToolPresentation,
  host: AgentToolHost,
): ToolDefinition {
  return defineTool<typeof agentSchema, AgentDetails>({
    ...presentationOf(presentation),
    description: withTypes(presentation.description, host.types),
    parameters: agentSchema,
    // Permission rules and hooks see the type a call starts (`Agent(<type>)`, T23).
    // Pi validates the arguments against the schema after this.
    prepareArguments: (args) =>
      (isObject(args) && args.subagent_type === undefined
        ? { ...args, subagent_type: DEFAULT_TYPE }
        : args) as Static<typeof agentSchema>,
    async execute(toolCallId, params, signal, onUpdate) {
      const call: AgentCall = {
        description: params.description,
        prompt: params.prompt,
        type: params.subagent_type ?? DEFAULT_TYPE,
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.effort === undefined ? {} : { effort: params.effort }),
        ...(params.isolation === undefined ? {} : { isolation: params.isolation }),
        ...(params.run_in_background === undefined ? {} : { background: params.run_in_background }),
      };
      const outcome = await host.run(toolCallId, call, signal, (subagent, activity) => {
        onUpdate?.({ content: [{ type: 'text', text: activity }], details: { subagent } });
      });
      // Pi records a thrown error as the call's error result; the run's state reaches the
      // card through `subagent/completed` and the parent's `piarc.subagentState` entry.
      if (outcome.isError) throw new Error(outcome.text);
      return { content: [{ type: 'text', text: outcome.text }], details: outcome.details };
    },
  });
}
