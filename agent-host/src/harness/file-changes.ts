// Files changed outside the session (T27, ADR-0043 rule 3): before each reminder delivery
// (a run's start, after a round of tool calls) Core compares the session's file state table
// with the disk (`fs/changes`) and returns each new version once; each becomes a `fileModified`
// reminder. A failed request only skips this round.
import type { ChangedFile } from '@piarc/protocol';

import { describeError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { fileChangedNotice } from './prompts/notices.js';
import type { Reminders } from './reminders.js';

function parseChanges(value: unknown): ChangedFile[] | undefined {
  if (!isObject(value) || !Array.isArray(value.files)) return undefined;
  const files: ChangedFile[] = [];
  for (const file of value.files) {
    if (
      !isObject(file) ||
      typeof file.path !== 'string' ||
      (file.change !== 'modified' && file.change !== 'deleted')
    ) {
      return undefined;
    }
    files.push({ path: file.path, change: file.change });
  }
  return files;
}

/** The collector that queues the session's external changes. */
export function fileChanges(
  bridge: CoreBridge,
  sessionId: string,
  reminders: Reminders,
  log: (line: string) => void,
): (signal?: AbortSignal) => Promise<void> {
  return async (signal) => {
    let files: ChangedFile[];
    try {
      files = await bridge.requestTyped(
        'fs/changes',
        { sessionId },
        parseChanges,
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      log(`fs/changes failed: ${describeError(error)}`);
      return;
    }
    for (const file of files) {
      reminders.enqueue(`file:${file.path}`, {
        type: 'fileModified',
        source: file.path,
        text: fileChangedNotice(file.path, file.change),
      });
    }
  };
}
