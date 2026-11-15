// `Edit`: Pi's edit tool (matching, fuzzy fallback, line-ending preservation, diff) on a stand-in
// path, reading and writing through Core (`fs/stat`, `fs/read`, `fs/write`). Edits of one file are
// serialized with `Write`'s.
import {
  defineTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { asFileError, FileError, type CoreIo, type Origin } from './core-io.js';
import { mutationKey, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { serialized, StandIn } from './stand-in.js';

type EditDefinition = ReturnType<typeof createEditToolDefinition>;

export function createEditTool({ io, presentation }: ToolSetup): ToolDefinition {
  const template = createEditToolDefinition('.');
  return defineTool<EditDefinition['parameters'], EditToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    ...(template.prepareArguments === undefined
      ? {}
      : { prepareArguments: template.prepareArguments }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const standIn = new StandIn(resolveToolPath(params.path, ctx.cwd));
      const pi = createEditToolDefinition(ctx.cwd, {
        operations: operations(io, standIn, { tool: 'Edit', toolCallId }),
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

function operations(io: CoreIo, standIn: StandIn, origin: Origin): EditOperations {
  return {
    // Pi checks read and write access: a missing file is ENOENT, a read-only one EACCES.
    access: async (file) => {
      const target = standIn.resolve(file);
      let stat;
      try {
        stat = await io.stat(target, origin);
      } catch (error) {
        throw asFileError(error, 'access', target);
      }
      if (stat.readonly) {
        throw new FileError('EACCES', 'access', target);
      }
    },
    readFile: async (file) => {
      const target = standIn.resolve(file);
      try {
        return await io.readText(target, origin);
      } catch (error) {
        throw asFileError(error, 'read', target);
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
