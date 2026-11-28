import {
  isProjectPath,
  projectRecord,
  type ProjectEntry,
  type ProjectFile,
  type ProjectMatch,
  type ProjectRequest,
  type ProjectSearch,
} from '../../shared/project-files.js';
export type { ProjectEntry, ProjectFile, ProjectMatch } from '../../shared/project-files.js';

async function request(id: string, operation: ProjectRequest) {
  const value: unknown = JSON.parse(await window.piarc.projectFiles(id, operation));
  if (!projectRecord(value)) throw new TypeError('Invalid project file response');
  return value;
}

export async function listProjectFiles(id: string, path: string, includeChild?: string) {
  const value = await request(id, { op: 'list', path, ...(includeChild ? { includeChild } : {}) });
  if (!Array.isArray(value.entries) || typeof value.truncated !== 'boolean')
    throw new TypeError('Invalid directory listing');
  const entries = value.entries.map((row: unknown): ProjectEntry => {
    if (
      !projectRecord(row) ||
      !isProjectPath(row.path) ||
      typeof row.name !== 'string' ||
      (row.kind !== 'file' && row.kind !== 'directory' && row.kind !== 'other')
    )
      throw new TypeError('Invalid directory entry');
    const link = row.link;
    if (
      link !== undefined &&
      (!projectRecord(link) ||
        typeof link.target !== 'string' ||
        !['ok', 'external', 'dangling', 'cycle'].includes(String(link.state)))
    )
      throw new TypeError('Invalid directory link');
    return {
      name: row.name,
      path: row.path,
      kind: row.kind,
      ...(link ? { link: link as NonNullable<ProjectEntry['link']> } : {}),
    };
  });
  return { entries, truncated: value.truncated };
}
export async function searchProjectFiles(id: string, options: ProjectSearch) {
  const value = await request(id, { op: 'search', ...options });
  if (!Array.isArray(value.results) || typeof value.truncated !== 'boolean')
    throw new TypeError('Invalid project search results');
  const results = value.results.map((row: unknown): ProjectMatch => {
    if (
      !projectRecord(row) ||
      !isProjectPath(row.path) ||
      typeof row.name !== 'string' ||
      (row.kind !== 'file' && row.kind !== 'directory')
    )
      throw new TypeError('Invalid project search match');
    return {
      path: row.path,
      name: row.name,
      kind: row.kind,
      ...(typeof row.preview === 'string' ? { preview: row.preview } : {}),
      ...(typeof row.line === 'number' ? { line: row.line } : {}),
      ...(typeof row.column === 'number' ? { column: row.column } : {}),
      ...(Array.isArray(row.positions)
        ? { positions: row.positions.filter((n: unknown): n is number => typeof n === 'number') }
        : {}),
      ...(Array.isArray(row.ranges)
        ? {
            ranges: row.ranges.filter(
              (r: unknown): r is [number, number] =>
                Array.isArray(r) &&
                r.length === 2 &&
                r.every((n: unknown) => typeof n === 'number'),
            ),
          }
        : {}),
    };
  });
  return { results, truncated: value.truncated };
}
export async function cancelProjectSearch(id: string, searchId: string) {
  await request(id, { op: 'cancel', searchId });
}
export async function readProjectFile(
  id: string,
  path: string,
  force = false,
): Promise<ProjectFile> {
  const row = await request(id, { op: 'read', path, force });
  if (
    row.path !== path ||
    typeof row.size !== 'number' ||
    typeof row.editable !== 'boolean' ||
    !['text', 'image', 'audio', 'video', 'pdf', 'binary', 'tooLarge', 'missing'].includes(
      String(row.kind),
    )
  )
    throw new TypeError('Invalid project file');
  if (row.kind === 'text' && (typeof row.text !== 'string' || typeof row.revision !== 'string'))
    throw new TypeError('Invalid text file');
  return {
    path,
    kind: row.kind as ProjectFile['kind'],
    size: row.size,
    editable: row.editable,
    ...(typeof row.text === 'string' ? { text: row.text } : {}),
    ...(typeof row.revision === 'string' ? { revision: row.revision } : {}),
    ...(typeof row.mime === 'string' ? { mime: row.mime } : {}),
  };
}
export async function saveProjectFile(
  id: string,
  path: string,
  text: string,
  revision: string | null,
) {
  const row = await request(id, { op: 'save', path, text, revision });
  if (typeof row.revision !== 'string' || typeof row.size !== 'number')
    throw new TypeError('Invalid project file revision');
  return { revision: row.revision, size: row.size };
}
