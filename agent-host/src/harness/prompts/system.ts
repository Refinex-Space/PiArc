// The seven slots follow architecture section 6.6.1. Slots 3, 5 and 6 have no M1 producer.
import type { MemoryFile } from '@piarc/protocol';
import { CANONICAL_TOOLS, type ToolProfile } from '../../tools/profile.js';

export const IDENTITY = [
  'You are PiArc, a coding agent working alongside the person who opened this workspace.',
  'Inspect the relevant files before choosing an edit. Preserve the user’s work and keep changes focused on the requested outcome.',
  'Check the result with the project’s own tools. Explain what you verified and identify anything that still needs attention.',
].join('\n');

export function sourced(file: MemoryFile): string {
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

export function assembleSystem(
  tools: readonly string[],
  profile: ToolProfile | undefined,
  files: readonly MemoryFile[],
  environment: { cwd: string; platform: string; date: string; gitStatus?: string },
): FrozenSystem {
  const sections: [string, string][] = [
    ['identity', IDENTITY],
    ['tool_guidance', toolGuidance(tools, profile)],
    ['project_context', files.map(sourced).join('\n\n')],
    [
      'environment',
      [
        `Working directory: ${environment.cwd}`,
        `Platform: ${environment.platform}`,
        `Session date: ${environment.date}`,
        `Git status at session start:\n${environment.gitStatus ?? 'Unavailable.'}`,
      ].join('\n'),
    ],
  ];
  const parts = sections.map(([name, body]) => `<${name}>\n${body}\n</${name}>`);
  const stable = parts.slice(0, 2).join('\n\n') + '\n\n';
  return { text: stable + parts.slice(2).join('\n\n'), cacheBoundary: stable.length };
}
