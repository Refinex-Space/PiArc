// MCP prompts as slash commands (architecture section 6.8, T40): pi-mcp has no prompts API, so
// the pool lists them with generic requests (`prompts/list`, refreshed on
// `notifications/prompts/list_changed`) and this module turns them into commands and expands
// a typed `/mcp__<server>__<prompt> args` into the input the model gets (`prompts/get`).
//
// - Name: `mcp__<server>__<prompt>`, the server name with every character outside
//   `[A-Za-z0-9_-]` replaced by `_` and the prompt name as the server declares it (Claude
//   Code's form). Only connected servers offer commands: an untrusted project's servers never
//   connect, so they offer none.
// - Arguments: split on whitespace and given to the prompt's arguments in their declared order;
//   words beyond the last argument join it. A missing required argument fails the input.
// - Result: the text of every message, joined by blank lines. Another content type (image,
//   audio, a resource) fails the input with a message saying so: PiArc does not send it.
import type { CommandInfo, PromptCommand, SkillsCatalog } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { McpPrompt, McpPromptMessage } from './connection.js';

/** What expanding a prompt needs from the pool. */
export interface PromptSource {
  prompts(): readonly { readonly server: string; readonly prompts: readonly McpPrompt[] }[];
  getPrompt(
    server: string,
    name: string,
    args: Readonly<Record<string, string>>,
  ): Promise<readonly McpPromptMessage[]>;
}

/** The command name of prompt `prompt` of server `server`. */
export function promptCommandName(server: string, prompt: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/gu, '_')}__${prompt}`;
}

function hint(prompt: McpPrompt): string | undefined {
  if (prompt.arguments.length === 0) return undefined;
  return prompt.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

/** The commands of the connected servers' prompts, in server order. */
export function promptCommands(source: PromptSource): CommandInfo[] {
  return source.prompts().flatMap(({ server, prompts }) =>
    prompts.map((prompt): CommandInfo => {
      const argumentHint = hint(prompt);
      return {
        name: promptCommandName(server, prompt.name),
        kind: 'mcpPrompt',
        source: 'mcp',
        description: prompt.description ?? `${prompt.name} (${server})`,
        ...(argumentHint === undefined ? {} : { argumentHint }),
        ...(prompt.arguments.length === 0
          ? {}
          : { arguments: prompt.arguments.map((a) => a.name) }),
      };
    }),
  );
}

/** What a typed MCP prompt command became. */
export interface ExpandedPrompt {
  readonly text: string;
  readonly command: PromptCommand;
}

/** `/name rest` of `text`, when it is a slash command. */
function slash(text: string): { name: string; rest: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/mcp__')) return undefined;
  const space = trimmed.search(/\s/u);
  return space === -1
    ? { name: trimmed.slice(1), rest: '' }
    : { name: trimmed.slice(1, space), rest: trimmed.slice(space + 1).trim() };
}

/** The prompt's arguments from the typed words. */
export function promptArguments(
  command: string,
  prompt: McpPrompt,
  rest: string,
): Record<string, string> {
  const words = rest === '' ? [] : rest.split(/\s+/u);
  const args: Record<string, string> = {};
  prompt.arguments.forEach((arg, index) => {
    const last = index === prompt.arguments.length - 1;
    const value = last ? words.slice(index).join(' ') : words[index];
    if (value !== undefined && value !== '') args[arg.name] = value;
  });
  const missing = prompt.arguments.filter((a) => a.required && args[a.name] === undefined);
  if (missing.length > 0) {
    throw new AhpError(
      'invalidParams',
      `/${command} needs ${missing.map((a) => `<${a.name}>`).join(' ')}`,
      { details: { command, missing: missing.map((a) => a.name) } },
    );
  }
  return args;
}

/** The text of the messages; another content type fails. */
export function promptText(command: string, messages: readonly McpPromptMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) {
      const type =
        typeof block === 'object' && block !== null && 'type' in block
          ? String((block as { type: unknown }).type)
          : 'unknown';
      const text =
        type === 'text' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : undefined;
      if (text === undefined) {
        throw new AhpError(
          'invalidParams',
          `/${command} returned ${type} content, which PiArc does not send; only text prompts work`,
          { details: { command, contentType: type } },
        );
      }
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Expands `text` when it is an MCP prompt command (`/mcp__…`): undefined for any other text.
 * Fails for a prompt no connected server offers, a missing required argument, or content
 * other than text.
 */
export async function expandMcpPrompt(
  source: PromptSource,
  text: string,
): Promise<ExpandedPrompt | undefined> {
  const typed = slash(text);
  if (typed === undefined) return undefined;
  for (const { server, prompts } of source.prompts()) {
    const prompt = prompts.find((p) => promptCommandName(server, p.name) === typed.name);
    if (prompt === undefined) continue;
    const args = promptArguments(typed.name, prompt, typed.rest);
    const messages = await source.getPrompt(server, prompt.name, args);
    return {
      text: promptText(typed.name, messages),
      command: {
        name: typed.name,
        kind: 'mcpPrompt',
        source: 'mcp',
        ...(typed.rest === '' ? {} : { arguments: typed.rest }),
        input: text.trim(),
      },
    };
  }
  throw new AhpError('invalidParams', `/${typed.name} is not a prompt of a connected MCP server`, {
    details: { command: typed.name },
  });
}

/** `catalog` with the connected servers' prompts after every other command (a taken name
 * keeps its command). */
export function withPromptCommands(
  catalog: SkillsCatalog,
  source: PromptSource | undefined,
): SkillsCatalog {
  if (source === undefined) return catalog;
  const taken = new Set(catalog.commands.map((c) => c.name));
  const prompts = promptCommands(source).filter((c) => !taken.has(c.name));
  return { ...catalog, commands: [...catalog.commands, ...prompts] };
}

/** An input whose text is a typed MCP prompt command, expanded; other input as it is (a
 * command Core expanded already is left alone). */
export async function expandInput<
  T extends { readonly text: string; readonly command?: PromptCommand },
>(source: PromptSource, input: T): Promise<T> {
  if (input.command != null) return input;
  const expanded = await expandMcpPrompt(source, input.text);
  if (expanded === undefined) return input;
  return { ...input, text: expanded.text, mentions: [], command: expanded.command };
}
