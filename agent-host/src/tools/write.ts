// `Write`: Pi's write tool on a stand-in path, with the directory and the file created by Core
// (`fs/mkdir`, `fs/write`). Writes to one file are serialized with `Edit`'s. Core checks that an
// existing file was read by this session and is unchanged since, writes atomically in the file's
// encoding and byte order mark, converts the new text to the file's line ending style
// (`matchFile`), and returns the diff, which goes into the result's details (`fileDiff`).
import {
  defineTool,
  createWriteToolDefinition,
  type ToolDefinition,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { FileDiff } from '@piarc/protocol';

import { asFileError, type CoreIo, type Origin } from './core-io.js';
import { mutationKey, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { serialized, StandIn } from './stand-in.js';

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;

export function createWriteTool({ io, presentation }: ToolSetup): ToolDefinition {
  const template = createWriteToolDefinition('.');
  return defineTool<WriteDefinition['parameters'], { fileDiff: FileDiff } | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const standIn = new StandIn(resolveToolPath(params.path, ctx.cwd));
      const change: { diff?: FileDiff } = {};
      const pi = createWriteToolDefinition(ctx.cwd, {
        operations: operations(io, standIn, { tool: 'Write', toolCallId }, change),
      });
      return serialized(mutationKey(standIn.real), async () => {
        try {
          const result = await pi.execute(
            toolCallId,
            { ...params, path: standIn.path },
            signal,
            onUpdate,
            ctx,
          );
          const restored = standIn.restore(result, params.path);
          return {
            ...restored,
            details: change.diff === undefined ? undefined : { fileDiff: change.diff },
          };
        } catch (error) {
          throw standIn.restoreError(error, params.path);
        }
      });
    },
  });
}

function operations(
  io: CoreIo,
  standIn: StandIn,
  origin: Origin,
  change: { diff?: FileDiff },
): WriteOperations {
  return {
    mkdir: async (dir) => {
      const target = standIn.resolve(dir);
      try {
        await io.mkdir(target, origin);
      } catch (error) {
        throw asFileError(error, 'mkdir', target);
      }
    },
    writeFile: async (file, content) => {
      const target = standIn.resolve(file);
      try {
        const diff = await io.write(target, content, origin, 'matchFile');
        if (diff !== undefined) {
          change.diff = diff;
        }
      } catch (error) {
        throw asFileError(error, 'open', target);
      }
    },
  };
}
