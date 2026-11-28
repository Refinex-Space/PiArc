import { isProjectPath } from '../../shared/project-files.js';
import type { FileLocation } from './file-path.js';
export { fileLocation, projectFileRoot } from './file-path.js';
export type { FileLocation } from './file-path.js';
import { showPanel } from '../shell/registry.js';

export const FILE_DRAG_TYPE = 'application/x-piarc-project-files';
const pending = new Map<string, FileLocation>();
const opens = new Set<(id: string) => void>();
const attachments = new Map<string, (paths: readonly string[]) => void>();
export interface ProjectFileLinks {
  readonly sessionId: string;
  readonly root: string;
  readonly directory: string;
  readonly document?: string;
}

export function openProjectFile(id: string, location: FileLocation) {
  pending.set(id, location);
  showPanel('files');
  for (const fn of opens) fn(id);
}
export function takeFileLocation(id: string) {
  const next = pending.get(id);
  pending.delete(id);
  return next;
}
export function onFileLocation(fn: (id: string) => void) {
  opens.add(fn);
  return () => {
    opens.delete(fn);
  };
}
export function attachProjectFiles(id: string, paths: readonly string[]) {
  attachments.get(id)?.(paths);
}
export function onFileAttachment(id: string, fn: (paths: readonly string[]) => void) {
  attachments.set(id, fn);
  return () => {
    if (attachments.get(id) === fn) attachments.delete(id);
  };
}
export function droppedFiles(
  data: DataTransfer | null,
  session: string | undefined,
): readonly string[] | undefined {
  if (!data?.types.includes(FILE_DRAG_TYPE)) return undefined;
  if (!session) return [];
  try {
    const row: unknown = JSON.parse(data.getData(FILE_DRAG_TYPE));
    if (
      typeof row === 'object' &&
      row !== null &&
      'sessionId' in row &&
      row.sessionId === session &&
      'paths' in row &&
      Array.isArray(row.paths) &&
      row.paths.length <= 100 &&
      row.paths.every((p) => isProjectPath(p))
    )
      return row.paths;
  } catch {
    /* A drag from another application may not have our payload. */
  }
  return [];
}
