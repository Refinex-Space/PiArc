// The `Skill` tool (T37, ADR-0054 rule 7): loads a skill's instructions through Core
// (`skills/invoke`), which consumes the call's approval, fills in the arguments, grants the
// skill's `allowed-tools` until the turn ends and turns its hooks on. The instructions are the
// tool result, so they stay in the conversation with the call that loaded them.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { presentationOf } from '../../tools/presentation.js';
import type { ToolPresentation } from '../../tools/profile.js';
import type { SessionSkills } from './session-skills.js';

const schema = Type.Object({
  skill: Type.String({ minLength: 1, description: 'The skill’s name as listed' }),
  args: Type.Optional(Type.String({ description: 'Text the skill works with' })),
});

/** What the transcript keeps about a load (`details.skill`). */
export interface SkillToolDetails {
  readonly skill: string;
}

export function createSkillTool(
  presentation: ToolPresentation,
  skills: SessionSkills,
): ToolDefinition {
  return defineTool<typeof schema, SkillToolDetails>({
    ...presentationOf(presentation),
    parameters: schema,
    async execute(toolCallId, params, signal) {
      const loaded = await skills.load(toolCallId, params.skill.trim(), params.args, signal);
      return {
        content: [{ type: 'text', text: loaded.text }],
        details: { skill: loaded.name },
      };
    },
  });
}
