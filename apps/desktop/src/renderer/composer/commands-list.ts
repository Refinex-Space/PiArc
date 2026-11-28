// Core's `listCommands` answer (T37): the slash commands of a session's directory and the output
// styles, checked at the IPC boundary. Malformed entries are left out.
import type { PaletteCommand } from './command-plugin.js';

/** An output style the user can choose. */
export interface StyleChoice {
  readonly name: string;
  /** Core's text; built-in styles are described by the client. */
  readonly description: string;
  readonly source: string;
}

/** The commands and output styles of a session. */
export interface CommandsList {
  readonly commands: readonly PaletteCommand[];
  readonly styles: readonly StyleChoice[];
  /** The style in effect. */
  readonly style: string;
}

export const EMPTY_COMMANDS: CommandsList = { commands: [], styles: [], style: 'Default' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Parses `listCommands`' JSON text. */
export function parseCommandsList(json: string): CommandsList {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return EMPTY_COMMANDS;
  }
  if (!isRecord(value)) return EMPTY_COMMANDS;
  const commands = Array.isArray(value.commands)
    ? value.commands.flatMap((entry: unknown): PaletteCommand[] =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.source === 'string'
          ? [
              {
                name: entry.name,
                kind: entry.kind,
                source: entry.source,
                description: text(entry.description),
                ...(typeof entry.argumentHint === 'string'
                  ? { argumentHint: entry.argumentHint }
                  : {}),
                ...(Array.isArray(entry.aliases)
                  ? {
                      aliases: entry.aliases.filter(
                        (alias: unknown): alias is string => typeof alias === 'string',
                      ),
                    }
                  : {}),
              },
            ]
          : [],
      )
    : [];
  const styles = Array.isArray(value.outputStyles)
    ? value.outputStyles.flatMap((entry: unknown): StyleChoice[] =>
        isRecord(entry) && typeof entry.name === 'string' && typeof entry.source === 'string'
          ? [{ name: entry.name, source: entry.source, description: text(entry.description) }]
          : [],
      )
    : [];
  const current = isRecord(value.outputStyle) ? text(value.outputStyle.name) : '';
  return { commands, styles, style: current === '' ? 'Default' : current };
}
