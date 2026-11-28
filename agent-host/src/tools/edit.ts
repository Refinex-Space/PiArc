// `Edit`: Pi's edit tool (matching, fuzzy fallback, line-ending preservation, diff) on a stand-in
// path, reading and writing through Core (`fs/stat`, `fs/read`, `fs/write`). Edits of one file are
// serialized with `Write`'s. T16 (architecture section 6.1.2):
//
// - the read asks Core to check that this session read the file and it is unchanged since
//   (`requireFresh`), and Core checks again when it writes; the errors tell the model to Read;
// - `replaceAll` replaces every occurrence (`replace-all.ts`); without it each `oldText` must
//   occur once, and Pi's error for several occurrences gets a hint about `replaceAll`;
// - Core writes atomically in the file's encoding, and the diff it returns goes into the result's
//   details (`fileDiff`), from where the projection puts it on the `fileChange` item.
import {
  defineTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { FileDiff } from '@piarc/protocol';
import { Type } from 'typebox';

import { asFileError, FileError, type CoreIo, type Origin } from './core-io.js';
import { mutationKey, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { replaceAll } from './replace-all.js';
import { serialized, StandIn } from './stand-in.js';

const template = createEditToolDefinition('.');

/** Pi's parameters plus `replaceAll`. */
const editSchema = Type.Object({
  ...template.parameters.properties,
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        'Replace every occurrence of each oldText instead of requiring exactly one. The ' +
        'match must still be exact.',
    }),
  ),
});

/** Pi's details plus the change Core made. */
export type FileChangeDetails = Partial<EditToolDetails> & { fileDiff?: FileDiff };

export function createEditTool({ io, presentation }: ToolSetup): ToolDefinition {
  return defineTool<typeof editSchema, FileChangeDetails | undefined>({
    ...presentationOf(presentation),
    parameters: editSchema,
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    ...(template.prepareArguments === undefined
      ? {}
      : { prepareArguments: template.prepareArguments }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const origin: Origin = { tool: 'Edit', toolCallId };
      const standIn = new StandIn(resolveToolPath(params.path, ctx.cwd));
      return serialized(mutationKey(standIn.real), async () => {
        if (params.replaceAll === true) {
          const raw = (await io.readText(standIn.real, origin, signal, true)).toString('utf8');
          const { text, count } = replaceAll(raw, params.edits, params.path);
          const fileDiff = await io.write(standIn.real, text, origin);
          return {
            content: [
              {
                type: 'text',
                text: `Replaced ${String(count)} occurrence(s) in ${params.path}.`,
              },
            ],
            details: fileDiff === undefined ? undefined : { fileDiff },
          };
        }
        const change: { diff?: FileDiff } = {};
        const pi = createEditToolDefinition(ctx.cwd, {
          operations: operations(io, standIn, origin, change),
        });
        try {
          // Pi's edit takes the path and the edits; `replaceAll` is this tool's own.
          const result = await pi.execute(
            toolCallId,
            { path: standIn.path, edits: params.edits },
            signal,
            onUpdate,
            ctx,
          );
          const restored = standIn.restore(result, params.path);
          const details: FileChangeDetails = {
            ...restored.details,
            ...(change.diff === undefined ? {} : { fileDiff: change.diff }),
          };
          return { ...restored, details };
        } catch (error) {
          throw withReplaceAllHint(standIn.restoreError(error, params.path));
        }
      });
    },
  });
}

/** Pi's error for a text found several times, with the way out this tool adds. */
function withReplaceAllHint(error: unknown): unknown {
  if (error instanceof Error && /^Found \d+ occurrences\b/.test(error.message)) {
    const hinted = new Error(
      `${error.message} To change every occurrence, call Edit again with replaceAll: true.`,
    );
    hinted.name = error.name;
    return hinted;
  }
  return error;
}

function operations(
  io: CoreIo,
  standIn: StandIn,
  origin: Origin,
  change: { diff?: FileDiff },
): EditOperations {
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
        return await io.readText(target, origin, undefined, true);
      } catch (error) {
        throw asFileError(error, 'read', target);
      }
    },
    writeFile: async (file, content) => {
      const target = standIn.resolve(file);
      try {
        const diff = await io.write(target, content, origin);
        if (diff !== undefined) {
          change.diff = diff;
        }
      } catch (error) {
        throw asFileError(error, 'open', target);
      }
    },
  };
}
