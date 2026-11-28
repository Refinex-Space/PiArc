import { isProjectPath } from '../../shared/project-files.js';
import type { SessionEntry } from '../store/snapshots.js';
export interface FileLocation {
  path: string;
  line?: number;
  endLine?: number;
}
/** Matches the Core browsing scope, including the separate checkout of a worktree session. */
export function projectFileRoot(session: SessionEntry | undefined): string {
  return session?.worktreePath ?? session?.workspace ?? session?.cwd ?? '';
}

/** Model paths are data: only validated, worktree-relative results may reach the file viewer. */
export function projectPath(raw: string, root: string, relativeTo = ''): string | undefined {
  let path = raw.replaceAll('\\', '/');
  if (!path || path.length > 4096 || path.endsWith('/') || /^~(?:\/|$)/u.test(path))
    return undefined;
  const windows = /^(?:[a-z]:|[/\\]{2})/iu.test(root);
  const absolute = path.startsWith('/') || /^[a-z]:\//iu.test(path);
  const parts = relativeTo && !absolute ? relativeTo.split('/') : [];
  if (absolute) {
    if (!root) return undefined;
    const prefix = root.replaceAll('\\', '/').replace(/\/+$/u, '') + '/';
    if (!(windows ? path.toLowerCase() : path).startsWith(windows ? prefix.toLowerCase() : prefix))
      return undefined;
    path = path.slice(prefix.length);
    if (path.split('/').includes('..')) return undefined;
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
  for (const part of path.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const result = parts.join('/');
  return isProjectPath(result) && !(windows && result.includes(':')) ? result : undefined;
}

/** Markdown line suffixes apply only to link destinations. Tool and filesystem names are literal. */
export function fileLocation(raw: string, root: string, relativeTo = ''): FileLocation | undefined {
  const suffix = /(?:#L|:)(\d+)(?:-L?(\d+))?$/u.exec(raw);
  const result = projectPath(suffix ? raw.slice(0, suffix.index) : raw, root, relativeTo);
  if (result === undefined) return undefined;
  if (!suffix) return { path: result };
  const line = Number(suffix[1]),
    endLine = Number(suffix[2] ?? suffix[1]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || line < 1 || endLine < line)
    return undefined;
  return { path: result, line, ...(suffix[2] ? { endLine } : {}) };
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function absoluteFilePath(root: string, relative: string): string {
  const separator = /^(?:[a-z]:|\\\\)/iu.test(root) ? '\\' : '/';
  return root.replace(/[\\/]+$/u, '') + separator + relative.split('/').join(separator);
}

/** Files identifies rows relative to the checkout. A mention must name the same file to the
 * model when its current working directory is a nested folder of that checkout. */
export interface MentionScope {
  readonly root: string;
  readonly directory: string;
}
export function fileMentionPath(path: string, scope: MentionScope | undefined): string {
  if (!scope?.directory) return path;
  const from = scope.directory.split('/'),
    to = path.split('/');
  const windows = /^(?:[a-z]:|[/\\]{2})/iu.test(scope.root);
  let common = 0;
  while (common < from.length && common < to.length) {
    const a = from[common],
      b = to[common];
    if (windows ? a?.toLowerCase() !== b?.toLowerCase() : a !== b) break;
    common++;
  }
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/') || '.';
}
