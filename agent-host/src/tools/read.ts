// `Read`: Pi's read tool (line selection, truncation notices, image handling) on a stand-in path,
// with every file access done by Core (`fs/stat`, `fs/read`).
import {
  defineTool,
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { FileStat } from '@piarc/protocol';

import { asFileError, errorCode, FileError, type CoreIo, type Origin } from './core-io.js';
import { readPathCandidates, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { StandIn } from './stand-in.js';

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;

/** What the path lookup found: the file, or why it is not readable. */
interface Lookup {
  readonly path: string;
  readonly stat?: FileStat;
  readonly error?: unknown;
}

export function createReadTool({ io, presentation }: ToolSetup): ToolDefinition {
  const template = createReadToolDefinition('.');
  return defineTool<ReadDefinition['parameters'], ReadToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    ...(template.outputSchema === undefined ? {} : { outputSchema: template.outputSchema }),
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const origin: Origin = { tool: 'Read', toolCallId };
      const lookup = await find(io, resolveToolPath(params.path, ctx.cwd), origin);
      const standIn = new StandIn(lookup.path);
      const pi = createReadToolDefinition(ctx.cwd, {
        operations: operations(io, standIn, lookup, origin),
      });
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
    },
  });
}

/** The first of the path's spellings that exists (Pi's `resolveReadPath`), checked by Core. */
async function find(io: CoreIo, resolved: string, origin: Origin): Promise<Lookup> {
  for (const candidate of readPathCandidates(resolved)) {
    try {
      return { path: candidate, stat: await io.stat(candidate, origin, true) };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        // Outside the workspace, unreadable: the other spellings would fare no better.
        return { path: candidate, error };
      }
    }
  }
  return { path: resolved };
}

function operations(io: CoreIo, standIn: StandIn, lookup: Lookup, origin: Origin): ReadOperations {
  const real = (requested: string): string => standIn.resolve(requested);
  return {
    // The lookup already asked Core; access only reports its outcome.
    access: async (requested) => {
      const target = real(requested);
      if (lookup.error !== undefined) {
        throw asFileError(lookup.error, 'access', target);
      }
      if (lookup.stat === undefined) {
        throw new FileError('ENOENT', 'access', target);
      }
      await Promise.resolve();
    },
    detectImageMimeType: (requested) => {
      real(requested);
      return Promise.resolve(lookup.stat?.imageMimeType ?? null);
    },
    createReadStream: (requested, { signal }) =>
      mapped(io.readChunks(real(requested), origin, signal), requested, real),
    readFile: async (requested) => {
      const target = real(requested);
      try {
        return await io.readBytes(target, origin);
      } catch (error) {
        throw asFileError(error, 'open', target);
      }
    },
  };
}

/** The chunks, with Core's errors shaped like Node's read errors. */
async function* mapped(
  chunks: AsyncGenerator<Buffer>,
  requested: string,
  real: (requested: string) => string,
): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks;
  } catch (error) {
    throw asFileError(error, 'read', real(requested));
  }
}
