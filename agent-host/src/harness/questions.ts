// `AskUserQuestion` (architecture section 6.5, T26): structured questions shown as a form in
// the client. The call goes to Core as `ui/ask`, which keeps the form in the session's approval
// ledger (every window shows it, the first valid answer counts) and answers when the user
// does, when they close the form, or when the configured timeout passes. The form shows in
// every permission mode; its permission check treats the tool like a read-only one.
//
// The model receives the results as JSON: per question the `outcome` (`answered`, `default`
// after a timeout with default options, `unanswered` after a timeout without, `declined` when
// the user closed the form), the picked option labels and the user's own answer.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Question, QuestionOutcome, QuestionResult, UiAskResult } from '@piarc/protocol';
import { Type } from 'typebox';

import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';

function isOutcome(value: unknown): value is QuestionOutcome {
  return (
    value === 'answered' || value === 'default' || value === 'unanswered' || value === 'declined'
  );
}

const askSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ minLength: 1, description: 'The question, ending with "?".' }),
      header: Type.Optional(
        Type.String({ description: 'A label of a few words shown above the question.' }),
      ),
      options: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, description: 'The choice, in a few words.' }),
          description: Type.Optional(
            Type.String({ description: 'What choosing it means or leads to.' }),
          ),
          default: Type.Optional(
            Type.Boolean({ description: 'Taken when the form times out without an answer.' }),
          ),
        }),
        { minItems: 2, maxItems: 4 },
      ),
      multiSelect: Type.Optional(
        Type.Boolean({ description: 'Whether several options may be picked.' }),
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

/** Core's answer, checked. */
export function parseAskResult(value: unknown): UiAskResult | undefined {
  if (!isObject(value) || !Array.isArray(value.results)) return undefined;
  const results: QuestionResult[] = [];
  for (const result of value.results) {
    if (
      !isObject(result) ||
      typeof result.question !== 'string' ||
      !isOutcome(result.outcome) ||
      !(
        result.selected === undefined ||
        (Array.isArray(result.selected) && result.selected.every((s) => typeof s === 'string'))
      ) ||
      !(result.other === undefined || typeof result.other === 'string')
    ) {
      return undefined;
    }
    results.push({
      question: result.question,
      outcome: result.outcome,
      ...(Array.isArray(result.selected) ? { selected: result.selected } : {}),
      ...(typeof result.other === 'string' ? { other: result.other } : {}),
    });
  }
  if (value.feedback === undefined) return { results };
  return typeof value.feedback === 'string' ? { results, feedback: value.feedback } : undefined;
}

/** What the model reads: a sentence on how the form ended, then the results as JSON. */
export function askResultText(result: UiAskResult): string {
  const outcomes = new Set(result.results.map((r) => r.outcome));
  const lead = outcomes.has('declined')
    ? 'The user closed the form without answering.'
    : outcomes.has('default') || outcomes.has('unanswered')
      ? 'The form timed out: questions with default options took them, the others have no answer.'
      : 'The user answered.';
  const answers = result.results.map((r) => ({
    question: r.question,
    outcome: r.outcome,
    selected: r.selected ?? [],
    ...(r.other === undefined ? {} : { other: r.other }),
  }));
  return `${lead}\n${JSON.stringify(
    result.feedback === undefined ? { answers } : { answers, feedback: result.feedback },
  )}`;
}

export function createAskUserQuestionTool(
  presentation: ToolPresentation,
  bridge: CoreBridge,
  sessionId: string,
): ToolDefinition {
  return defineTool<typeof askSchema, UiAskResult>({
    ...presentationOf(presentation),
    parameters: askSchema,
    async execute(toolCallId, params, signal) {
      const questions: Question[] = params.questions.map((q) => ({
        question: q.question.toWellFormed(),
        ...(q.header === undefined ? {} : { header: q.header.toWellFormed() }),
        options: q.options.map((o) => ({
          label: o.label.toWellFormed(),
          ...(o.description === undefined ? {} : { description: o.description.toWellFormed() }),
          ...(o.default === true ? { default: true } : {}),
        })),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
      }));
      // Core sends policy/pending once the form shows, which stops the transport deadline.
      const result = await bridge.requestTyped(
        'ui/ask',
        { sessionId, toolCallId, questions },
        parseAskResult,
        {
          approval: { sessionId, toolCallId },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return { content: [{ type: 'text', text: askResultText(result) }], details: result };
    },
  });
}
