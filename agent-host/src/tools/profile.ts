// Canonical tool names, Tool Profiles and the name map (architecture section 6.1.1).
//
// PiArc's tools carry Claude Code's canonical names (`Read`, `Bash`, ...) so permission rules,
// hooks and subagent tool lists written for Claude Code apply unchanged. A Tool Profile decides
// what one model sees: the model-visible name, the description and the system prompt lines of
// every tool. Rules, hooks and Core always use canonical names; `ToolNameMap` translates.
//
// The descriptions are PiArc's own text (ADR-0006): they describe the behavior of these tools
// (Pi's tool implementations behind Core's I/O), not Claude Code's.

/** The tools the default profile exposes, in the order the model sees them. */
export const CANONICAL_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

/** A canonical tool name of this tool set. */
export type CanonicalTool = (typeof CANONICAL_TOOLS)[number];

/** Pi's built-in tool names; sessions exclude them so the model never sees them. */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = [
  'read',
  'bash',
  'powershell',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
];

/** How one tool is presented to the model. */
export interface ToolPresentation {
  /** Model-visible name. */
  readonly name: string;
  /** The tool description sent with the tool definition. */
  readonly description: string;
  /** One line for the system prompt's tool list. */
  readonly snippet: string;
  /** Lines for the system prompt's guidelines while the tool is active. */
  readonly guidelines: readonly string[];
}

/** A Tool Profile: the presentation of every canonical tool. */
export type ToolProfile = Readonly<Record<CanonicalTool, ToolPresentation>>;

/** The default profile: canonical names, PiArc's descriptions. */
export const DEFAULT_PROFILE: ToolProfile = {
  Read: {
    name: 'Read',
    description:
      'Return the contents of one file. Text comes back as at most 2000 lines or 50 KB, ' +
      'whichever ends first; page through longer files with `offset` (first line to show, ' +
      'counting from 1) and `limit` (number of lines), following the note at the end of the ' +
      'output. JPEG, PNG, GIF, WebP and BMP files come back as images. `path` is absolute or ' +
      'relative to the working directory.',
    snippet: 'Read: show a text file or an image',
    guidelines: ['Look at files with Read rather than printing them through Bash.'],
  },
  Write: {
    name: 'Write',
    description:
      'Store `content` as the complete text of the file at `path`: a new file is created ' +
      '(with any missing parent directories), an existing one is replaced. To change part of ' +
      'an existing file, Edit is safer.',
    snippet: 'Write: create a file or replace all of its text',
    guidelines: [],
  },
  Edit: {
    name: 'Edit',
    description:
      'Change an existing file by replacing exact passages. Each entry of `edits` gives an ' +
      '`oldText`, copied character for character from the file (indentation and line breaks ' +
      'included) and found exactly once in it, and the `newText` that takes its place. All ' +
      'entries refer to the file as it is before the call and must not overlap; put several ' +
      'changes to one file into one call.',
    snippet: 'Edit: replace exact passages of an existing file',
    guidelines: [
      'Keep each oldText short but unique; merge changes that sit close together into one entry.',
    ],
  },
  Bash: {
    name: 'Bash',
    description:
      'Run a command line with bash in the working directory and return what it printed ' +
      '(stdout and stderr) and, when it fails, its exit code. Only the last 2000 lines or ' +
      '50 KB of output are shown; the complete output is then saved to a file named in the ' +
      'result. `timeout` is in seconds; without it the command may run indefinitely. Every ' +
      'call starts a new shell: `cd` and exported variables do not carry over.',
    snippet: 'Bash: run a shell command',
    guidelines: [],
  },
  Glob: {
    name: 'Glob',
    description:
      'List the files and directories below `path` (default: the working directory) that ' +
      'match a glob `pattern`. Without `/` the pattern matches names at any depth (`*.json`); ' +
      'with `/` it matches paths relative to `path` (`src/**/*.test.ts`). Entries ignored by ' +
      '.gitignore are left out, directories end with `/`. At most `limit` entries (default ' +
      '1000) or 50 KB are returned.',
    snippet: 'Glob: find files by name or path pattern',
    guidelines: [],
  },
  Grep: {
    name: 'Grep',
    description:
      'Search file contents for a regular expression (or, with `literal`, a plain string) and ' +
      'return the matching lines as `file:line: text`. Searches the working directory unless ' +
      '`path` names a directory or a file; `glob` restricts which files are searched ' +
      '(`*.py`, `src/**/*.ts`); `context` adds lines around each match. Files ignored by ' +
      '.gitignore are skipped. At most `limit` matches (default 100) or 50 KB are returned, ' +
      'and very long lines are shortened.',
    snippet: 'Grep: search file contents with a regular expression',
    guidelines: ['Search with Grep and Glob rather than grep, rg or find in Bash.'],
  },
};

/** Model-visible names that providers accept everywhere. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Maps model-visible names to canonical names and back. Names it does not know (MCP tools,
 * extension tools) map to themselves. */
export class ToolNameMap {
  readonly #toCanonical = new Map<string, CanonicalTool>();
  readonly #toVisible = new Map<CanonicalTool, string>();

  constructor(profile: ToolProfile) {
    for (const canonical of CANONICAL_TOOLS) {
      const visible = profile[canonical].name;
      if (!TOOL_NAME.test(visible)) {
        throw new Error(
          `tool profile: ${canonical} has an invalid name ${JSON.stringify(visible)}`,
        );
      }
      if (PI_BUILTIN_TOOL_NAMES.includes(visible)) {
        throw new Error(
          `tool profile: ${canonical} may not be named ${visible}, a name of Pi's own tools`,
        );
      }
      const taken = this.#toCanonical.get(visible);
      if (taken !== undefined) {
        throw new Error(`tool profile: ${canonical} and ${taken} are both named ${visible}`);
      }
      this.#toCanonical.set(visible, canonical);
      this.#toVisible.set(canonical, visible);
    }
  }

  /** The canonical name of a model-visible name. */
  toCanonical(visible: string): string {
    return this.#toCanonical.get(visible) ?? visible;
  }

  /** The model-visible name of a canonical name. */
  toVisible(canonical: string): string {
    return isCanonicalTool(canonical) ? (this.#toVisible.get(canonical) ?? canonical) : canonical;
  }
}

export function isCanonicalTool(name: string): name is CanonicalTool {
  return (CANONICAL_TOOLS as readonly string[]).includes(name);
}

/**
 * The default profile with overrides applied: `overrides` maps canonical names to the members
 * that change (`{ "Read": { "name": "read_file" } }`). Used with `--tool-profile` by the tests
 * that check renaming; unknown tools and members are rejected.
 */
export function profileWithOverrides(overrides: unknown): ToolProfile {
  if (!isRecord(overrides)) {
    throw new Error('tool profile: expected an object keyed by canonical tool name');
  }
  const profile: Record<CanonicalTool, ToolPresentation> = { ...DEFAULT_PROFILE };
  for (const [tool, change] of Object.entries(overrides)) {
    if (!isCanonicalTool(tool)) {
      throw new Error(`tool profile: unknown tool ${tool}`);
    }
    if (!isRecord(change)) {
      throw new Error(`tool profile: ${tool} must map to an object`);
    }
    let next: ToolPresentation = profile[tool];
    for (const [member, value] of Object.entries(change)) {
      if (
        (member === 'name' || member === 'description' || member === 'snippet') &&
        typeof value === 'string'
      ) {
        next = { ...next, [member]: value };
      } else if (
        member === 'guidelines' &&
        Array.isArray(value) &&
        value.every((line): line is string => typeof line === 'string')
      ) {
        next = { ...next, guidelines: value };
      } else {
        throw new Error(`tool profile: ${tool}.${member} is not a known member of the right type`);
      }
    }
    profile[tool] = next;
  }
  // Validates the names.
  new ToolNameMap(profile);
  return profile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
