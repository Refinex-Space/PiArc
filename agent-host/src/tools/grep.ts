// `Grep`: searches through Core's `fs/grep` and formats the result as Pi's grep tool does.
//
// Pi 1.5.2's grep always runs ripgrep itself (`GrepOperations` only covers the directory check;
// since 1.5.1 even context lines come from ripgrep), so its code cannot be reused with Core doing
// the search. This tool keeps Pi's parameter schema and output: the formatting below follows
// `packages/coding-agent/src/core/tools/grep.ts` of Pi v1.5.2, MIT License, Copyright (c) 2025
// Mario Zechner. Core implements the search with ripgrep's libraries and Pi's match-limit rule.
import path from 'node:path';
import {
  defineTool,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type GrepToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { errorCode, isAborted, type Origin } from './core-io.js';
import { resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';

type GrepDefinition = ReturnType<typeof createGrepToolDefinition>;

const DEFAULT_LIMIT = 100;
/** Pi's `GREP_MAX_LINE_LENGTH`, the default of `truncateLine`. */
const MAX_LINE_LENGTH = 500;

export function createGrepTool({ io, presentation, searched }: ToolSetup): ToolDefinition {
  const template = createGrepToolDefinition('.');
  return defineTool<GrepDefinition['parameters'], GrepToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (isAborted(signal)) {
        throw new Error('Operation aborted');
      }
      const origin: Origin = { tool: 'Grep', toolCallId };
      const searchPath = resolveToolPath(params.path ?? '.', ctx.cwd);
      const context =
        params.context !== undefined && params.context > 0
          ? Math.min(Math.floor(params.context), Number.MAX_SAFE_INTEGER)
          : 0;
      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT));
      let result;
      try {
        result = await io.grep(
          {
            path: searchPath,
            pattern: params.pattern,
            // A leading "./" never matches; "!" negates.
            glob: params.glob?.replace(/^(!?)(?:\.\/)+/, '$1'),
            ignoreCase: params.ignoreCase,
            literal: params.literal,
            context,
            limit,
          },
          origin,
          signal,
        );
      } catch (error) {
        if (isAborted(signal)) {
          throw new Error('Operation aborted', { cause: error });
        }
        throw errorCode(error) === 'ENOENT'
          ? new Error(`Path not found: ${searchPath}`, { cause: error })
          : error;
      }
      if (searched) {
        const base = result.isDirectory ? result.path : path.dirname(result.path);
        const dirs = new Set([base]);
        for (const line of result.lines) dirs.add(path.dirname(path.resolve(base, line.path)));
        searched(toolCallId, [...dirs]);
      }
      if (result.matchCount === 0) {
        return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };
      }
      return format(result.lines, result.limitReached, limit);
    },
  });
}

function format(
  lines: readonly { path: string; lineNumber: number; text: string; isMatch: boolean }[],
  limitReached: boolean,
  limit: number,
): { content: { type: 'text'; text: string }[]; details: GrepToolDetails | undefined } {
  const outputLines: string[] = [];
  let outputBytes = 0;
  let linesTruncated = false;
  for (const line of lines) {
    const { text, wasTruncated } = truncateLine(line.text);
    if (wasTruncated) {
      linesTruncated = true;
    }
    const formatted = line.isMatch
      ? `${line.path}:${String(line.lineNumber)}: ${text}`
      : `${line.path}-${String(line.lineNumber)}- ${text}`;
    // Lines past the byte cap are counted, not kept: truncateHead drops them anyway.
    if (outputBytes - 1 <= DEFAULT_MAX_BYTES) {
      outputLines.push(formatted);
    }
    outputBytes += Buffer.byteLength(formatted, 'utf-8') + 1;
  }
  const truncation = truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  truncation.totalLines = lines.length;
  truncation.totalBytes = outputBytes - 1;
  let output = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (limitReached) {
    notices.push(
      `${String(limit)} matches limit reached. Use limit=${String(limit * 2)} for more, or refine pattern`,
    );
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(
      `Some lines truncated to ${String(MAX_LINE_LENGTH)} chars. Use read tool to see full lines`,
    );
    details.linesTruncated = true;
  }
  if (notices.length > 0) {
    output += `\n\n[${notices.join('. ')}]`;
  }
  return {
    content: [{ type: 'text', text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
