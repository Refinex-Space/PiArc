// `LsOperations` answered by Core (`fs/stat`, `fs/list`). Pi's ls has no canonical name
// (architecture section 6.1.1), so the default profile does not expose it; these operations are
// for later tools that list directories.
import type { LsOperations } from '@earendil-works/pi-coding-agent';

import { errorCode, FileError, type CoreIo, type Origin } from './core-io.js';

export function lsOperations(io: CoreIo, origin: Origin): LsOperations {
  return {
    exists: async (absolutePath) => {
      try {
        await io.stat(absolutePath, origin);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return false;
        }
        throw error;
      }
    },
    stat: async (absolutePath) => {
      try {
        const stat = await io.stat(absolutePath, origin);
        return { isDirectory: () => stat.kind === 'directory' };
      } catch (error) {
        const code = errorCode(error);
        throw code === undefined ? error : new FileError(code, 'stat', absolutePath);
      }
    },
    readdir: async (absolutePath) => {
      try {
        return (await io.list(absolutePath, origin)).map((entry) => entry.name);
      } catch (error) {
        const code = errorCode(error);
        throw code === undefined ? error : new FileError(code, 'scandir', absolutePath);
      }
    },
  };
}
