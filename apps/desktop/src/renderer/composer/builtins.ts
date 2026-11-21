// The built-in slash commands the client carries out (T37, ADR-0054 rule 13). Core lists them
// (`listCommands`, kind `builtIn`) with their aliases and argument hints; here each name maps to
// the existing feature it opens and to its localized description.
import type { MessageId } from '../../shared/i18n/index.js';

/** What a built-in command does in the client. */
export type BuiltinAction =
  'newSession' | 'compact' | 'rewind' | 'help' | 'model' | 'context' | 'outputStyle';

interface Builtin {
  readonly action: BuiltinAction;
  readonly label: MessageId;
}

const BUILTINS: Readonly<Record<string, Builtin>> = {
  clear: { action: 'newSession', label: 'composer.command.clear' },
  compact: { action: 'compact', label: 'composer.command.compact' },
  rewind: { action: 'rewind', label: 'composer.command.rewind' },
  help: { action: 'help', label: 'composer.command.help' },
  model: { action: 'model', label: 'composer.command.model' },
  context: { action: 'context', label: 'composer.command.context' },
  'output-style': { action: 'outputStyle', label: 'composer.command.outputStyle' },
};

/** Aliases Core lists for built-in commands, by name. */
const ALIASES: Readonly<Record<string, string>> = {
  reset: 'clear',
  new: 'clear',
  checkpoint: 'rewind',
};

/** The built-in command `name` (or an alias of one). */
export function builtin(name: string): (Builtin & { readonly name: string }) | undefined {
  const canonical = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  if (canonical === undefined || !Object.hasOwn(BUILTINS, canonical)) return undefined;
  const entry = BUILTINS[canonical];
  return entry === undefined ? undefined : { ...entry, name: canonical };
}

/** The built-in commands in the order the shortcut list shows them. */
export const BUILTIN_NAMES: readonly string[] = Object.keys(BUILTINS);

/**
 * A typed built-in command: `/name arguments` at the start of the text, with nothing but
 * whitespace before it. Undefined for other text (custom commands go to Core as typed).
 */
export function typedBuiltin(
  text: string,
): { readonly name: string; readonly action: BuiltinAction; readonly args: string } | undefined {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  const name = match?.[1];
  if (name === undefined) return undefined;
  const command = builtin(name);
  return command === undefined
    ? undefined
    : { name: command.name, action: command.action, args: (match?.[2] ?? '').trim() };
}
