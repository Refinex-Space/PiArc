// `Write`: Pi's write tool on a stand-in path, with the directory and the file created by Core
// (`fs/mkdir`, `fs/write`). Writes to one file are serialized with `Edit`'s.
import {
  defineTool,
  createWriteToolDefinition,
  type ToolDefinition,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';

import { asFileError, type CoreIo, type Origin } from './core-io.js';
import { mutationKey, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { serialized, StandIn } from './stand-in.js';

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;

export function createWriteTool({ io, presentation }: ToolSetup): ToolDefinition {
  const template = createWriteToolDefinition('.');
  return defineTool<WriteDefinition['parameters'], undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const standIn = new StandIn(resolveToolPath(params.path, ctx.cwd));
      const pi = createWriteToolDefinition(ctx.cwd, {
        operations: operations(io, standIn, { tool: 'Write', toolCallId }),
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
          return standIn.restore(result, params.path);
        } catch (error) {
          throw standIn.restoreError(error, params.path);
        }
      });
    },
  });
}

function operations(io: CoreIo, standIn: StandIn, origin: Origin): WriteOperations {
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
        await io.write(target, content, origin);
      } catch (error) {
        throw asFileError(error, 'open', target);
      }
    },
  };
}
