// The seven slots follow architecture section 6.6.1: identity, tool guidance, output style (T37),
// project context, skills index (T37), MCP servers (T36), environment.
import type { MemoryFile } from '@piarc/protocol';
import { CANONICAL_TOOLS, type ToolProfile } from '../../tools/profile.js';
import { MEMORY_PREAMBLE, managedSource } from './auto-memory.js';

export const IDENTITY = [
  'You are PiArc, a coding agent working alongside the person who opened this workspace.',
  'Inspect the relevant files before choosing an edit. Preserve the user’s work and keep changes focused on the requested outcome.',
  'Check the result with the project’s own tools. Explain what you verified and identify anything that still needs attention.',
].join('\n');

export function sourced(file: MemoryFile): string {
  // The organization's instructions and the auto memory index say what they are (T47).
  if (file.kind === 'managed') return `${managedSource(file.path)}\n${file.content}`;
  if (file.kind === 'autoMemory') {
    return `${MEMORY_PREAMBLE}\nSource: ${file.path}\n${file.content}`;
  }
  return `Source: ${file.path}\n${file.content}`;
}

function toolGuidance(active: readonly string[], profile: ToolProfile | undefined): string {
  const rows = ['Use the tools available in this session and respect their access decisions.'];
  const names = new Map(CANONICAL_TOOLS.map((key) => [key as string, profile?.[key].name ?? key]));
  const renamed = (line: string): string =>
    line.replace(
      /\b(Read|Write|Edit|Bash|PowerShell|Glob|Grep)\b/g,
      (key) => names.get(key) ?? key,
    );
  for (const name of active) {
    const key = CANONICAL_TOOLS.find((tool) => profile?.[tool].name === name);
    const entry = key === undefined ? undefined : profile?.[key];
    if (entry === undefined) {
      rows.push(`- ${name}`);
    } else {
      const snippet = renamed(entry.snippet);
      rows.push(`- ${snippet.startsWith(name + ':') ? snippet : name + ': ' + snippet}`);
      for (const guideline of entry.guidelines) rows.push(`  ${renamed(guideline)}`);
    }
  }
  return rows.join('\n');
}

/** UTF-16 offset of the session-specific suffix, computed before any document text is inserted. */
export interface FrozenSystem {
  text: string;
  cacheBoundary: number;
}

/** A subagent's prompt (T31): its definition's body as the identity; the read-only built-in
 * types leave out the project context and the git status. */
export interface Persona {
  readonly identity: string;
  readonly projectContext: boolean;
}

export function assembleSystem(
  tools: readonly string[],
  profile: ToolProfile | undefined,
  files: readonly MemoryFile[],
  environment: { cwd: string; platform: string; date: string; gitStatus?: string },
  persona?: Persona,
  mcp?: string,
  skills?: { readonly style?: string; readonly skills?: string },
): FrozenSystem {
  const context = persona?.projectContext !== false;
  const sections: [string, string][] = [
    ['identity', persona?.identity ?? IDENTITY],
    ['tool_guidance', toolGuidance(tools, profile)],
    // Section 3 (T37): the output style's instructions.
    ...(skills?.style === undefined ? [] : [['output_style', skills.style] as [string, string]]),
    ...(context ? [['project_context', files.map(sourced).join('\n\n')] as [string, string]] : []),
    // Section 5 (T37): the skills the model may load.
    ...(skills?.skills === undefined ? [] : [['skills', skills.skills] as [string, string]]),
    // Section 6 (T36): the connected MCP servers' instructions and the deferred servers.
    ...(mcp === undefined ? [] : [['mcp_servers', mcp] as [string, string]]),
    [
      'environment',
      [
        `Working directory: ${environment.cwd}`,
        `Platform: ${environment.platform}`,
        `Session date: ${environment.date}`,
        ...(context
          ? [`Git status at session start:\n${environment.gitStatus ?? 'Unavailable.'}`]
          : []),
      ].join('\n'),
    ],
  ];
  const parts = sections.map(([name, body]) => `<${name}>\n${body}\n</${name}>`);
  const stable = parts.slice(0, 2).join('\n\n') + '\n\n';
  return { text: stable + parts.slice(2).join('\n\n'), cacheBoundary: stable.length };
}
