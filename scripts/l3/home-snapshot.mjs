// The user's own Claude Code state, before and after an L3 run (T30-A03): every file under
// ~/.claude and ~/.claude.json, with size and modification time. The run must leave it
// unchanged; only paths relative to the home directory reach the report.
import { lstatSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {Map<string, string>} Snapshot relative path → "<size> <mtime ms>" */

/**
 * @param {string} [home]
 * @returns {Snapshot}
 */
export function snapshotClaudeHome(home = os.homedir()) {
  /** @type {Snapshot} */
  const snapshot = new Map();
  /** @param {string} full */
  const add = (full) => {
    try {
      const stat = lstatSync(full);
      const rel = path.relative(home, full).split(path.sep).join('/');
      if (stat.isDirectory()) {
        snapshot.set(`${rel}/`, 'dir');
        for (const name of readdirSync(full)) add(path.join(full, name));
      } else {
        snapshot.set(rel, `${String(stat.size)} ${String(stat.mtimeMs)}`);
      }
    } catch {
      // Absent (no ~/.claude.json) or removed while walking: the comparison sees it.
    }
  };
  add(path.join(home, '.claude'));
  add(path.join(home, '.claude.json'));
  return snapshot;
}

/**
 * Added, removed and changed paths between two snapshots.
 * @param {Snapshot} before
 * @param {Snapshot} after
 * @returns {string[]}
 */
export function snapshotChanges(before, after) {
  /** @type {string[]} */
  const changes = [];
  for (const [file, stamp] of before) {
    const now = after.get(file);
    if (now === undefined) changes.push(`removed ~/${file}`);
    else if (now !== stamp) changes.push(`changed ~/${file}`);
  }
  for (const file of after.keys()) if (!before.has(file)) changes.push(`added ~/${file}`);
  return changes.sort();
}
