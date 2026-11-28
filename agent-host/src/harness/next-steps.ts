// `SuggestNextSteps` (architecture section 6.5, T26): at the end of a turn the model offers a
// few follow-ups, each a title and the input that would carry it out. The call returns at once
// and does not hold the turn; the client shows the suggestions under the turn with two actions
// each: run it here (the next input of this session) or start a new session with it.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';

/** One suggested follow-up. */
export interface NextStep {
  readonly title: string;
  readonly prompt: string;
}

const nextSchema = Type.Object({
  suggestions: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, description: 'What the step does, in a few words.' }),
      prompt: Type.String({
        minLength: 1,
        description: 'The input that carries it out, written as the user would send it.',
      }),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

export function createSuggestNextStepsTool(presentation: ToolPresentation): ToolDefinition {
  return defineTool<typeof nextSchema, { suggestions: NextStep[] }>({
    ...presentationOf(presentation),
    parameters: nextSchema,
    execute(_toolCallId, params) {
      const suggestions = params.suggestions.map((s) => ({ title: s.title, prompt: s.prompt }));
      const text =
        `Showed ${String(suggestions.length)} suggested next step(s) to the user. ` +
        'Finish the turn; the user picks one if they want it.';
      return Promise.resolve({ content: [{ type: 'text', text }], details: { suggestions } });
    },
  });
}
