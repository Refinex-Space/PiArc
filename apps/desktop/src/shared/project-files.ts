// Paths crossing this boundary are portable, relative to the selected session's worktree.
export interface ProjectSearch {
  mode: 'name' | 'content';
  query: string;
  searchId: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}
export type ProjectRequest =
  | { op: 'list'; path: string; includeChild?: string }
  | { op: 'read'; path: string; force?: boolean }
  | { op: 'save'; path: string; text: string; revision: string | null }
  | ({ op: 'search' } & ProjectSearch)
  | { op: 'cancel'; searchId: string };
export interface ProjectEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'other';
  link?: { state: 'ok' | 'external' | 'dangling' | 'cycle'; target: string };
}
export interface ProjectMatch {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  line?: number;
  column?: number;
  preview?: string;
  ranges?: [number, number][];
  positions?: number[];
}
export interface ProjectFile {
  path: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary' | 'tooLarge' | 'missing';
  size: number;
  editable: boolean;
  text?: string;
  revision?: string;
  mime?: string;
}
export function isProjectPath(value: unknown, root = false): value is string {
  if (root && value === '') return true;
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\\') ||
    /^[a-z]:/iu.test(value)
  )
    return false;
  return (
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}
export function projectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isProjectRequest(value: unknown): value is ProjectRequest {
  if (!projectRecord(value)) return false;
  const id = typeof value.searchId === 'string' && /^[\w-]{1,100}$/u.test(value.searchId);
  switch (value.op) {
    case 'list':
      return (
        isProjectPath(value.path, true) &&
        (value.includeChild === undefined || isProjectPath(value.includeChild))
      );
    case 'read':
      return (
        isProjectPath(value.path) && (value.force === undefined || typeof value.force === 'boolean')
      );
    case 'save':
      return (
        isProjectPath(value.path) &&
        typeof value.text === 'string' &&
        value.text.length <= 4 * 1024 * 1024 &&
        (value.revision === null ||
          (typeof value.revision === 'string' && /^[a-f0-9]{64}$/u.test(value.revision)))
      );
    case 'cancel':
      return id;
    case 'search':
      return (
        id &&
        (value.mode === 'name' || value.mode === 'content') &&
        typeof value.query === 'string' &&
        value.query.length <= 512 &&
        ['matchCase', 'wholeWord', 'regexp'].every(
          (key) => value[key] === undefined || typeof value[key] === 'boolean',
        )
      );
    default:
      return false;
  }
}

export function canOpenSystemDocument(path: string): boolean {
  return /\.(?:pdf|png|jpe?g|gif|webp|avif|bmp|ico|mp[34]|m4[av]|ogg|wav|flac|webm|mov|txt|md|csv|tsv|docx|xlsx|pptx)$/iu.test(
    path,
  );
}
