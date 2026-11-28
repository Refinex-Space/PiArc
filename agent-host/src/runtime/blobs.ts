// Reads the blobs Core hands out instead of sending binary content over AHP (ADR-0009 rule 8):
// `fs/read` in blob mode copies a file to `<data dir>/sessions/<session id>/blobs/<sha256>` and
// returns that path. This is the one file the tools' I/O reaches through the Agent Host's own
// `fs`, and only below that directory.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BlobRef } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';

/** A reader for the blobs of PiArc's data directory `dataDir`. */
export function blobReader(dataDir: string): (blob: BlobRef) => Promise<Buffer> {
  const root = path.resolve(dataDir, 'sessions');
  return async (blob) => {
    const file = path.resolve(blob.path);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AhpError('invalidRequest', `blob ${blob.path} is not under ${root}`);
    }
    const bytes = await readFile(file);
    if (bytes.length !== blob.size) {
      throw new AhpError(
        'invalidRequest',
        `blob ${blob.path} has ${String(bytes.length)} bytes, not ${String(blob.size)}`,
      );
    }
    return bytes;
  };
}
