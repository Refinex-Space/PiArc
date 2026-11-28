// How the file tools turn a model's `path` argument into an absolute path, without touching the
// file system: the same rules as Pi's tools, so a path means what it means with Pi's own tools.
//
// Ported from Pi v1.5.2 `packages/coding-agent/src/utils/paths.ts` (`normalizePath`,
// `resolvePath`, `normalizeWindowsShellPath`) and `src/core/tools/path-utils.ts` (the read path
// variants), MIT License, Copyright (c) 2025 Mario Zechner. Changed: the variants are returned as
// candidates for Core to check instead of being probed with local `fs.access` calls.
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = '\u202F';

/** Git Bash, MSYS, Cygwin and WSL drive paths (`/c/Users/...`) in the form Windows accepts. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) {
    return filePath;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  const drive = match?.[1];
  if (drive === undefined) {
    return filePath;
  }
  const suffix = match?.[2]?.replaceAll('/', '\\');
  return `${drive.toUpperCase()}:\\${suffix ?? ''}`;
}

/** Pi's `normalizePath` with the options its file tools use. */
function normalizeToolPath(input: string): string {
  let normalized = input.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) {
    normalized = normalized.slice(1);
  }
  return expand(normalized);
}

/** Windows shell paths, `~` and `file://` URLs. */
function expand(input: string): string {
  const normalized = process.platform === 'win32' ? normalizeWindowsShellPath(input) : input;
  if (normalized === '~') {
    return homedir();
  }
  if (
    normalized.startsWith('~/') ||
    (process.platform === 'win32' && normalized.startsWith('~\\'))
  ) {
    return path.join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith('file://')) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

/** The absolute path a tool's `path` argument names, relative paths taken from `cwd`. */
export function resolveToolPath(requested: string, cwd: string): string {
  const normalized = normalizeToolPath(requested);
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(expand(cwd), normalized);
}

/**
 * The paths `Read` tries in order: the path itself, then the spellings macOS uses that users
 * rarely type (narrow no-break space before AM/PM in screenshot names, NFD normalization, curly
 * apostrophes, NFD with curly apostrophes). The first that exists is read.
 */
export function readPathCandidates(resolved: string): string[] {
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  const nfd = resolved.normalize('NFD');
  const curly = resolved.replace(/'/g, '\u2019');
  const nfdCurly = nfd.replace(/'/g, '\u2019');
  const candidates = [resolved];
  for (const variant of [amPm, nfd, curly, nfdCurly]) {
    if (!candidates.includes(variant)) {
      candidates.push(variant);
    }
  }
  return candidates;
}

/** Key under which writes to one file are serialized (case-insensitive on Windows). */
export function mutationKey(absolute: string): string {
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
