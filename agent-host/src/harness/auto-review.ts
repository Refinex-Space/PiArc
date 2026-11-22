// `policy/review` (Core → Agent Host, T46, design addendum
// docs/architecture/addenda/T46-auto-mode.md sections 1–5): one auxiliary model call that
// reviews a call Core would otherwise put to the user.
//
// - Input: segment A (static rules, `prompts/auto-review.ts`) and B (the user's policy, from
//   Core) form the system prompt; C–G are one JSON object in the only user message: the
//   environment, the user's own messages (from the main session's branch), a subagent's
//   delegated task, the recent calls without their results, and the pending call. Tool
//   results, web pages, MCP output, assistant text, memory, hook context, reminders and
//   compaction summaries never enter: the branch is read through the history projection, whose
//   user items are what the user typed and whose tool items carry only names and arguments.
// - Output: exactly one `record_review` call; its arguments go back to Core as given (Core
//   checks the verdict and the reason again). Anything else is `unparsable`.
// - Failures are answers too (`timeout`, `providerError`, `unknownModel`, `belowBar`): Core
//   puts the card back to the user for each.
// - The call is cached (`short`), thinking is off and the answer is at most 1,024 tokens; its
//   usage counts toward the reviewed session's turn (purpose `autoReview`).
import { createHash } from 'node:crypto';

import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Item, PolicyReviewParams, PolicyReviewResult } from '@piarc/protocol';

import { describeError } from '../protocol/errors.js';
import { capabilities, meetsReviewerBar } from '../providers/catalog.js';
import type { ModelPreferencesStore } from '../providers/preferences.js';
import { projectHistory } from '../runtime/history.js';
import { isObject } from '../runtime/items.js';
import type { AuxiliaryModel } from './auxiliary.js';
import {
  AUTO_REVIEW_SYSTEM,
  REVIEW_TOOL,
  REVIEW_TOOL_DESCRIPTION,
  REVIEW_TOOL_PARAMETERS,
} from './prompts/auto-review.js';

/** Bounds of the review input (addendum section 1.2), in characters. */
export const REVIEW_LIMITS = {
  /** One user message; longer ones keep their head and tail. */
  userMessage: 2_000,
  /** All user messages together. */
  userTotal: 12_000,
  /** A subagent's delegated task. */
  task: 4_000,
  /** Recent calls listed. */
  recentCalls: 20,
  /** One argument value of a recent call. */
  recentArgument: 300,
  /** All recent calls together. */
  recentTotal: 8_000,
  /** The pending call's arguments. */
  pending: 20_000,
} as const;

/** The reviewer's answer budget, in tokens. */
export const REVIEW_MAX_TOKENS = 1_024;

/** The first 12 hex digits of the SHA-256 of the review prompt: its version in the audit. */
export const REVIEW_PROMPT_ID = sha256(AUTO_REVIEW_SYSTEM).slice(0, 12);

/** What the review reads besides Core's parameters. */
export interface ReviewSources {
  /** The reviewed session's branch (its recent calls). */
  readonly own: readonly SessionEntry[];
  /** The main session's branch (the user's messages); the same as `own` for a main session. */
  readonly main: readonly SessionEntry[];
  /** A subagent's task as its parent's `Agent` call gave it. */
  readonly task?: { readonly description: string; readonly prompt: string };
  readonly toCanonical: (tool: string) => string;
}

export interface ReviewContext {
  /** The reviewed session's auxiliary channel: the usage counts there. */
  readonly auxiliary: AuxiliaryModel;
  readonly runtime: ModelRuntime;
  readonly preferences: ModelPreferencesStore;
}

/** The reviewer model of `params`, or the failure that keeps it from reviewing. */
function reviewer(
  params: PolicyReviewParams,
  context: ReviewContext,
): { model: Model<Api> } | { failure: 'unknownModel' | 'belowBar'; message: string } {
  const { provider, id } = params.model;
  const model = context.runtime.getModel(provider, id);
  if (model === undefined || !context.runtime.hasConfiguredAuth(model.provider)) {
    return {
      failure: 'unknownModel',
      message: `The reviewer model ${provider}/${id} is not configured or has no credentials.`,
    };
  }
  if (!meetsReviewerBar(context.preferences.apply(capabilities(model)))) {
    return {
      failure: 'belowBar',
      message: `The reviewer model ${provider}/${id} does not meet the reviewer bar.`,
    };
  }
  return { model };
}

export async function reviewCall(
  params: PolicyReviewParams,
  sources: ReviewSources,
  context: ReviewContext,
): Promise<PolicyReviewResult> {
  const name = `${params.model.provider}/${params.model.id}`;
  const base = { model: name, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const chosen = reviewer(params, context);
  if ('failure' in chosen) {
    return {
      ...base,
      failure: chosen.failure,
      message: chosen.message,
      inputHash: '',
      inputChars: 0,
      promptId: REVIEW_PROMPT_ID,
    };
  }
  const system = `${AUTO_REVIEW_SYSTEM}\n\n${policySection(params)}`;
  const prompt = reviewInput(params, sources);
  const sent = {
    inputHash: sha256(`${system}\u0000${prompt}`),
    inputChars: [...system].length + [...prompt].length,
    promptId: REVIEW_PROMPT_ID,
  };
  const timeout = AbortSignal.timeout(Math.max(1, params.timeoutMs));
  let answer;
  try {
    answer = await context.auxiliary.complete({
      purpose: 'autoReview',
      system,
      prompt,
      signal: timeout,
      model: chosen.model,
      tools: [
        {
          name: REVIEW_TOOL,
          description: REVIEW_TOOL_DESCRIPTION,
          parameters: REVIEW_TOOL_PARAMETERS,
        },
      ],
      cacheRetention: 'short',
      maxTokens: Math.min(REVIEW_MAX_TOKENS, chosen.model.maxTokens),
    });
  } catch (error) {
    return {
      ...base,
      ...sent,
      failure: timeout.aborted ? 'timeout' : 'providerError',
      message: timeout.aborted ? 'The review did not finish in time.' : describeError(error),
    };
  }
  const usage = {
    input: answer.usage.input,
    output: answer.usage.output,
    cacheRead: answer.usage.cacheRead,
    cacheWrite: answer.usage.cacheWrite,
  };
  const result = { ...sent, model: `${answer.model.provider}/${answer.model.id}`, usage };
  const calls = answer.toolCalls.filter((call) => call.name === REVIEW_TOOL);
  const only = calls.length === 1 ? calls[0] : undefined;
  const args: unknown = only?.argumentsError === undefined ? only?.arguments : undefined;
  if (
    !isObject(args) ||
    answer.toolCalls.length !== 1 ||
    typeof args.verdict !== 'string' ||
    typeof args.reason !== 'string'
  ) {
    return {
      ...result,
      failure: 'unparsable',
      message: `Expected exactly one ${REVIEW_TOOL} call with a verdict and a reason.`,
    };
  }
  return {
    ...result,
    answer: {
      verdict: args.verdict.toWellFormed(),
      reason: args.reason.toWellFormed(),
      ...(typeof args.category === 'string' ? { category: args.category.toWellFormed() } : {}),
    },
  };
}

/** Segment B: the user's additions, written "none" when absent. */
export function policySection(params: PolicyReviewParams): string {
  const list = (entries: readonly string[] | undefined) =>
    entries === undefined || entries.length === 0
      ? '(none)'
      : entries.map((entry) => `- ${entry}`).join('\n');
  const { policy } = params;
  return [
    "# The developer's additions",
    '',
    'Trusted infrastructure:',
    list(policy.environment),
    '',
    'Exceptions to the soft categories:',
    list(policy.allow),
    '',
    'Extra soft categories:',
    list(policy.softDeny),
    '',
    'Extra hard categories:',
    list(policy.hardDeny),
  ].join('\n');
}

/** Segments C–G as one JSON object (every text JSON-escaped). */
export function reviewInput(params: PolicyReviewParams, sources: ReviewSources): string {
  const own = projectHistory(sources.own, sources.toCanonical).map((h) => h.item);
  const main =
    sources.main === sources.own
      ? own
      : projectHistory(sources.main, sources.toCanonical).map((h) => h.item);
  const env = params.environment;
  const input = {
    environment: {
      platform: env.platform,
      workspace: env.workspace,
      cwd: env.cwd,
      gitRemotes: env.remotes ?? [],
      sandboxed: env.sandboxed === true,
      ...(env.agentType == null ? {} : { subagentType: env.agentType }),
    },
    user: userMessages(main),
    ...(sources.task === undefined
      ? {}
      : {
          delegated_task: {
            note: 'Written by another agent, not by the developer.',
            description: headTail(sources.task.description, 500),
            prompt: headTail(sources.task.prompt, REVIEW_LIMITS.task),
          },
        }),
    recent_actions: recentActions(own, params.toolCallId),
    pending: {
      tool: params.tool,
      arguments: headTail(JSON.stringify(params.input), REVIEW_LIMITS.pending),
      why: params.why,
    },
  };
  return JSON.stringify(input, null, 1).toWellFormed();
}

/** The user's messages: the first one and the latest that fit, oldest first. */
function userMessages(items: readonly Item[]): string[] {
  const texts = items.flatMap((item) => {
    if (item.type !== 'userMessage') return [];
    const files = (item.attachments ?? []).map((a) => a.name).filter((n) => n !== '');
    const text = files.length === 0 ? item.text : `${item.text}\n[attached: ${files.join(', ')}]`;
    return [headTail(text, REVIEW_LIMITS.userMessage)];
  });
  const [first, ...rest] = texts;
  if (first === undefined) return [];
  let budget = REVIEW_LIMITS.userTotal - [...first].length;
  const latest: string[] = [];
  for (const text of rest.reverse()) {
    const size = [...text].length;
    if (size > budget) break;
    budget -= size;
    latest.unshift(text);
  }
  return [first, ...latest];
}

const OUTCOMES: Readonly<Record<string, string>> = {
  completed: 'ran',
  failed: 'failed',
  declined: 'refused',
  interrupted: 'interrupted',
};

/** The latest calls before `pending`: names, arguments and how they ended, no results. */
function recentActions(items: readonly Item[], pending: string) {
  const calls = items.flatMap((item) =>
    'tool' in item && item.itemId !== pending && item.status in OUTCOMES
      ? [
          {
            tool: item.tool,
            arguments: Object.fromEntries(
              Object.entries(item.arguments).map(([key, value]) => [
                key,
                headTail(typeof value === 'string' ? value : JSON.stringify(value), REVIEW_LIMITS.recentArgument),
              ]),
            ),
            outcome: OUTCOMES[item.status],
          },
        ]
      : [],
  );
  const recent = calls.slice(-REVIEW_LIMITS.recentCalls);
  let budget = REVIEW_LIMITS.recentTotal;
  const kept: typeof recent = [];
  for (const call of recent.reverse()) {
    const size = JSON.stringify(call).length;
    if (size > budget) break;
    budget -= size;
    kept.unshift(call);
  }
  return kept;
}

/** `text` at most `limit` characters: longer text keeps its head and tail around a note. */
export function headTail(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  const keep = Math.max(0, limit - 40);
  const head = chars.slice(0, Math.ceil(keep / 2)).join('');
  const tail = chars.slice(chars.length - Math.floor(keep / 2)).join('');
  return `${head} [… ${String(chars.length - keep)} characters left out …] ${tail}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
