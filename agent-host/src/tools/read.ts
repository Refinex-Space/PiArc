// `Read`: Pi's read tool (line selection, truncation notices, image handling) on a stand-in path,
// with every file access done by Core (`fs/stat`, `fs/read`), plus what T16 adds (architecture
// sections 6.1.2 and 6.1.4):
//
// - text comes back with line numbers (`line-numbers.ts`), numbered before Pi selects lines;
// - the lookup records the read in Core's file state table with the call's range; a read that
//   repeats the previous one (same range, unchanged content) returns a short stub instead;
// - `.pdf` files return the text of their pages (`pages` parameter, Core's `fs/pdf`), `.ipynb`
//   files their cells with output summaries (`documents.ts`);
// - images keep Pi's handling; for a model without image input only the explanation remains.
import {
  defineTool,
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { FileStat, ReadRange } from '@piarc/protocol';
import { Type } from 'typebox';

import { asFileError, errorCode, FileError, type CoreIo, type Origin } from './core-io.js';
import { formatNotebook, formatPdf } from './documents.js';
import { numberedChunks, numberedText } from './line-numbers.js';
import { readPathCandidates, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { StandIn } from './stand-in.js';

const template = createReadToolDefinition('.');

/** Pi's parameters plus `pages` for PDFs. */
const readSchema = Type.Object({
  ...template.parameters.properties,
  pages: Type.Optional(
    Type.String({
      description:
        'PDF files only: the pages to read, such as "3" or "1-5"; at most 20 per call. ' +
        'Required for PDFs over 10 pages.',
    }),
  ),
});

type ReadResult = Awaited<ReturnType<(typeof template)['execute']>>;

/** What the path lookup found: the file, or why it is not readable. */
interface Lookup {
  readonly path: string;
  readonly stat?: FileStat;
  readonly error?: unknown;
}

export function createReadTool({
  io,
  presentation,
  autoResizeImages = true,
}: ToolSetup): ToolDefinition {
  return defineTool<typeof readSchema, ReadToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: readSchema,
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const origin: Origin = { tool: 'Read', toolCallId };
      const range = readRange(params);
      const lookup = await find(io, resolveToolPath(params.path, ctx.cwd), origin, range);
      if (lookup.stat?.unchanged === true) {
        return text(
          `${params.path} is unchanged since your last Read of it with the same range: that ` +
            'result still holds, so it is not repeated here.',
        );
      }
      const document = lookup.stat?.kind === 'file' ? documentKind(lookup.path) : undefined;
      if (document === 'pdf') {
        const pdf = await io.pdf(lookup.path, params.pages, origin);
        return text(formatPdf(params.path, pdf));
      }
      if (document === 'notebook') {
        const json = (await io.readText(lookup.path, origin, signal)).toString('utf8');
        return text(formatNotebook(params.path, json));
      }
      const standIn = new StandIn(lookup.path);
      const pi = createReadToolDefinition(ctx.cwd, {
        autoResizeImages,
        operations: operations(io, standIn, lookup, origin),
      });
      try {
        // Pi's read takes the path and the line range; `pages` is this tool's own.
        const result = await pi.execute(
          toolCallId,
          {
            path: standIn.path,
            ...(params.offset === undefined ? {} : { offset: params.offset }),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
          },
          signal,
          onUpdate,
          ctx,
        );
        const restored = standIn.restore(result, params.path);
        return forModel(restored, ctx.model?.input.includes('image') !== false);
      } catch (error) {
        throw standIn.restoreError(error, params.path);
      }
    },
  });
}

/** The call's range as Core records it: only the members the call gave. */
function readRange(params: { offset?: number; limit?: number; pages?: string }): ReadRange {
  const range: ReadRange = {};
  if (params.offset !== undefined && Number.isSafeInteger(params.offset) && params.offset >= 0) {
    range.offset = params.offset;
  }
  if (params.limit !== undefined && Number.isSafeInteger(params.limit) && params.limit >= 0) {
    range.limit = params.limit;
  }
  if (params.pages !== undefined) {
    range.pages = params.pages;
  }
  return range;
}

function documentKind(path: string): 'pdf' | 'notebook' | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return 'pdf';
  }
  return lower.endsWith('.ipynb') ? 'notebook' : undefined;
}

function text(content: string): ReadResult {
  return { content: [{ type: 'text', text: content }], details: undefined };
}

/**
 * The result as the model gets it: without the image when the model takes no images (the
 * note Pi adds says so), and with a note instead of nothing for an empty file.
 */
function forModel(result: ReadResult, vision: boolean): ReadResult {
  let content = result.content;
  if (!vision) {
    content = content.filter((block) => block.type !== 'image');
  }
  const only = content.length === 1 ? content[0] : undefined;
  if (only?.type === 'text' && only.text === '') {
    content = [{ type: 'text', text: 'The file is empty.' }];
  }
  return content === result.content ? result : { ...result, content };
}

/**
 * The first of the path's spellings that exists (Pi's `resolveReadPath`), checked by Core, which
 * also records the read with `range`.
 */
async function find(
  io: CoreIo,
  resolved: string,
  origin: Origin,
  range: ReadRange,
): Promise<Lookup> {
  for (const candidate of readPathCandidates(resolved)) {
    try {
      return { path: candidate, stat: await io.stat(candidate, origin, true, range) };
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
  const image = lookup.stat?.imageMimeType !== undefined;
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
      numberedChunks(mapped(io.readChunks(real(requested), origin, signal), requested, real)),
    readFile: async (requested) => {
      const target = real(requested);
      try {
        if (image) {
          return await io.readBytes(target, origin);
        }
        // Text through the whole-file path (unusual ranges): numbered like the stream.
        const whole = await io.readText(target, origin);
        return Buffer.from(numberedText(whole.toString('utf8')), 'utf8');
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
