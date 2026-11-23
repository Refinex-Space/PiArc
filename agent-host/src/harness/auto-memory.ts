// The `Memory` tool (T47, design addendum `T47-auto-memory-and-managed-settings.md` section 2):
// the model keeps notes for later sessions of the repository. Core does the work
// (`memory/apply`): it consumes the call's permission, reads or writes the repository's memory
// directory, rewrites the index and audits every change. This tool only forwards the call and
// tells the session's memory about its own change, so the next run does not send the index
// back as news.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MemoryFile } from '@piarc/protocol';
import { Type } from 'typebox';

import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import type { CoreIo } from '../tools/core-io.js';

const schema = Type.Object({
  action: Type.Union([Type.Literal('read'), Type.Literal('save'), Type.Literal('delete')], {
    description: 'read, save or delete',
  }),
  name: Type.Optional(Type.String({ description: 'The note’s name' })),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal('user'),
        Type.Literal('feedback'),
        Type.Literal('project'),
        Type.Literal('reference'),
      ],
      { description: 'What the note is about (save)' },
    ),
  ),
  description: Type.Optional(Type.String({ description: 'One line for the index (save)' })),
  content: Type.Optional(Type.String({ description: 'The note in Markdown (save)' })),
});

/** What the transcript keeps about a call (`details.memory`). */
export interface MemoryToolDetails {
  readonly action: 'read' | 'save' | 'delete';
  readonly name?: string;
  readonly changed: boolean;
}

/** What the tool needs from its session. */
export interface MemoryToolHost {
  readonly io: CoreIo;
  /** The session saved or deleted a note: the index as Core now gives it to new sessions. */
  readonly changed: (index: MemoryFile) => void;
}

export function createMemoryTool(
  presentation: ToolPresentation,
  host: MemoryToolHost,
): ToolDefinition {
  return defineTool<typeof schema, MemoryToolDetails>({
    ...presentationOf(presentation),
    parameters: schema,
    async execute(toolCallId, params, signal) {
      const name = params.name?.trim();
      const result = await host.io.memoryApply(
        {
          toolCallId,
          action: params.action,
          ...(name === undefined || name === '' ? {} : { name }),
          ...(params.type === undefined ? {} : { type: params.type }),
          ...(params.description === undefined ? {} : { description: params.description }),
          ...(params.content === undefined ? {} : { content: params.content }),
        },
        signal,
      );
      // When the last note is gone there is no index; the next run says it is no longer loaded.
      if (result.changed === true && result.index != null) host.changed(result.index);
      return {
        content: [{ type: 'text', text: result.text }],
        details: {
          action: params.action,
          ...(name === undefined || name === '' ? {} : { name }),
          changed: result.changed === true,
        },
      };
    },
  });
}
