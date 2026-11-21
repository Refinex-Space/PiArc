import { describe, expect, it } from 'vitest';

import { AhpError } from '../protocol/errors.js';
import { parsePrompts, type McpPrompt, type McpPromptMessage } from './connection.js';
import {
  expandMcpPrompt,
  promptCommandName,
  promptCommands,
  type PromptSource,
} from './prompts.js';

const greet: McpPrompt = {
  name: 'greet',
  description: 'Greets someone',
  arguments: [
    { name: 'name', required: true },
    { name: 'tone', required: false },
  ],
};

function source(messages: readonly McpPromptMessage[]): PromptSource & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    prompts: () => [{ server: 'docs.v2', prompts: [greet, { name: 'bare', arguments: [] }] }],
    getPrompt: (server, name, args) => {
      calls.push({ server, name, args });
      return Promise.resolve(messages);
    },
  };
}

describe('MCP prompts as commands', () => {
  it('names and describes each prompt with its arguments', () => {
    expect(promptCommandName('docs.v2', 'greet')).toBe('mcp__docs_v2__greet');
    expect(promptCommands(source([]))).toEqual([
      {
        name: 'mcp__docs_v2__greet',
        kind: 'mcpPrompt',
        source: 'mcp',
        description: 'Greets someone',
        argumentHint: '<name> [tone]',
        arguments: ['name', 'tone'],
      },
      {
        name: 'mcp__docs_v2__bare',
        kind: 'mcpPrompt',
        source: 'mcp',
        description: 'bare (docs.v2)',
      },
    ]);
  });

  it('expands a typed command with positional arguments', async () => {
    const s = source([{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }]);
    const expanded = await expandMcpPrompt(s, '  /mcp__docs_v2__greet Ada very warm ');
    expect(s.calls).toEqual([
      { server: 'docs.v2', name: 'greet', args: { name: 'Ada', tone: 'very warm' } },
    ]);
    expect(expanded).toEqual({
      text: 'Hello Ada',
      command: {
        name: 'mcp__docs_v2__greet',
        kind: 'mcpPrompt',
        source: 'mcp',
        arguments: 'Ada very warm',
        input: '/mcp__docs_v2__greet Ada very warm',
      },
    });
    expect(await expandMcpPrompt(s, 'not a command')).toBeUndefined();
    expect(await expandMcpPrompt(s, '/compact')).toBeUndefined();
  });

  it('refuses a missing required argument, unknown prompts and non-text content', async () => {
    const s = source([
      { role: 'user', content: { type: 'image', data: 'AA', mimeType: 'image/png' } },
    ]);
    await expect(expandMcpPrompt(s, '/mcp__docs_v2__greet')).rejects.toThrow('needs <name>');
    await expect(expandMcpPrompt(s, '/mcp__docs_v2__nope x')).rejects.toBeInstanceOf(AhpError);
    await expect(expandMcpPrompt(s, '/mcp__docs_v2__bare')).rejects.toThrow(
      'returned image content',
    );
  });

  it('parses prompts/list pages leniently', () => {
    expect(
      parsePrompts({
        prompts: [
          { name: 'a', arguments: [{ name: 'x', required: true }, { bad: 1 }] },
          { description: 'no name' },
        ],
        nextCursor: 'c2',
      }),
    ).toEqual({ prompts: [{ name: 'a', arguments: [{ name: 'x', required: true }] }], next: 'c2' });
    expect(parsePrompts(null)).toEqual({ prompts: [] });
  });
});
