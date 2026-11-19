// `Glob`: Pi's find tool (result relativizing, limits, notices) with `FindOperations` delegated
// to Core: `exists` to `fs/stat`, `glob` to `fs/glob`. Given a custom `glob`, Pi's find never
// starts fd and touches no file itself.
import path from 'node:path';
import {
  defineTool,
  createFindToolDefinition,
  type FindOperations,
  type FindToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { errorCode, type CoreIo, type Origin } from './core-io.js';
import { presentationOf, type ToolSetup } from './presentation.js';

type FindDefinition = ReturnType<typeof createFindToolDefinition>;

export function createGlobTool({ io, presentation, searched }: ToolSetup): ToolDefinition {
  const template = createFindToolDefinition('.');
  return defineTool<FindDefinition['parameters'], FindToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const pi = createFindToolDefinition(ctx.cwd, {
        operations: findOperations(io, { tool: 'Glob', toolCallId }, searched),
      });
      return pi.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

/** `FindOperations` answered by Core. */
export function findOperations(
  io: CoreIo,
  origin: Origin,
  searched?: ToolSetup['searched'],
): FindOperations {
  return {
    exists: async (absolutePath) => {
      try {
        await io.stat(absolutePath, origin);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return false;
        }
        throw error;
      }
    },
    glob: async (pattern, cwd, { ignore, limit }) => {
      const matches = await io.glob(cwd, pattern, { exclude: ignore, limit }, origin);
      if (searched) {
        const dirs = new Set([cwd]);
        for (const match of matches) {
          const full = path.resolve(cwd, match);
          dirs.add(match.endsWith('/') ? full : path.dirname(full));
        }
        searched(origin.toolCallId, [...dirs]);
      }
      return matches;
    },
  };
}
