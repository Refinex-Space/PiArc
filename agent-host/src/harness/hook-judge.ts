// `hooks/prompt` (Core → Agent Host, T38, ADR-0055): Core runs a `prompt` hook and asks the
// session's auxiliary model channel for the one judgement. The hook's `model` goes through the
// one model-spec resolver (aliases included); without one the auxiliary model answers. The
// usage counts toward the session's turn like any auxiliary call.
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { HooksPromptResult } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { resolveModel } from '../providers/aliases.js';
import type { AuxiliaryModel } from './auxiliary.js';
import { HOOK_JUDGE_SYSTEM } from './prompts/hook-judge.js';

export interface JudgeRequest {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs: number;
}

export interface JudgeContext {
  readonly auxiliary: AuxiliaryModel;
  readonly runtime: ModelRuntime;
  /** The model aliases (Core's `agents/list` answer), read only for an alias. */
  readonly aliases: () => Promise<Readonly<Record<string, string>>>;
}

/** The model a hook's `model` names, or undefined for the auxiliary model. */
async function hookModel(spec: string | undefined, context: JudgeContext) {
  if (spec === undefined || spec.trim() === '') return undefined;
  const inherit: Model<Api> = context.auxiliary.model();
  const resolved = resolveModel(spec, {
    aliases: await context.aliases(),
    inherit,
    available: await context.runtime.getAvailable(),
  });
  if (!resolved.ok) {
    throw new AhpError('invalidParams', `prompt hook model: ${resolved.message}`);
  }
  return resolved.model;
}

export async function judgeHook(
  request: JudgeRequest,
  context: JudgeContext,
): Promise<HooksPromptResult> {
  const model = await hookModel(request.model, context);
  const answer = await context.auxiliary.complete({
    purpose: 'hookPrompt',
    system: HOOK_JUDGE_SYSTEM,
    prompt: request.prompt,
    signal: AbortSignal.timeout(Math.max(1, request.timeoutMs)),
    ...(model === undefined ? {} : { model }),
  });
  return {
    text: answer.text,
    model: `${answer.model.provider}/${answer.model.id}`,
    inputTokens: answer.usage.input,
    outputTokens: answer.usage.output,
  };
}
