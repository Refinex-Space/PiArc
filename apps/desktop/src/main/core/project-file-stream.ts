// Keep the version returned by an opened file across every chunk and range.
import { projectRecord } from '../../shared/project-files.js';
import type { CoreRuntime } from './native/piarc-core.js';
type Files = Pick<CoreRuntime, 'projectFiles'>;
export async function projectChunk(
  core: Files,
  session: string,
  path: string,
  offset: number,
  length: number,
  revision?: string,
  /** The built-in browser reads (B1.6): Core applies the session's Read deny rules. */
  browser = false,
) {
  const raw: unknown = JSON.parse(
    await core.projectFiles(
      session,
      JSON.stringify({
        op: 'chunk',
        path,
        offset,
        length,
        revision,
        ...(browser ? { browser } : {}),
      }),
    ),
  );
  if (
    !projectRecord(raw) ||
    typeof raw.size !== 'number' ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 0 ||
    typeof raw.revision !== 'string' ||
    typeof raw.base64 !== 'string' ||
    (revision !== undefined && raw.revision !== revision)
  )
    throw new Error('Project file changed during read');
  return { size: raw.size, revision: raw.revision, bytes: Buffer.from(raw.base64, 'base64') };
}
export async function* readProjectRange(
  core: Files,
  id: string,
  path: string,
  revision: string,
  start: number,
  end: number,
  active: () => boolean,
) {
  for (let offset = start; offset <= end;) {
    if (!active()) throw new Error('Project file read was cancelled');
    const length = Math.min(1024 * 1024, end - offset + 1);
    const { bytes } = await projectChunk(core, id, path, offset, length, revision);
    if (!active() || bytes.length !== length) throw new Error('Incomplete project file read');
    offset += length;
    yield bytes;
  }
}
