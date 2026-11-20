// The L3 recording: what each side's run leaves on disk (tmp/l3/<run>/recordings/), one file
// per side and scenario. Both sides' captures become the same shape, and absolute paths
// become placeholders before anything is written. scripts/l3/check-recordings.mjs checks
// every file against the whitelist schema.
import path from 'node:path';

import { isRecord } from '../lib/repo.mjs';

export const FORMAT = 'piarc-l3-recording/1';

/**
 * @typedef {{ format: string, side: 'piarc' | 'claude-code', version: string,
 *   scenario: string, run: { exit: number | null, failures: string[] },
 *   requests: unknown[],
 *   trace: { tool_calls: unknown[], asks: unknown[], hooks: unknown[],
 *     final: { status: string }, files: Record<string, string> } }} Recording
 */

/**
 * Replaces each absolute path of `paths` (longest first, in both separator styles) with
 * its placeholder in every string of `value`, and turns the separators that follow a
 * placeholder into `/`.
 * @param {unknown} value
 * @param {[string, string][]} paths `[absolute path, placeholder]`
 * @returns {unknown}
 */
export function scrubPaths(value, paths) {
  const sorted = [...paths].filter(([p]) => p !== '').sort(([a], [b]) => b.length - a.length);
  /** @param {string} text */
  const scrub = (text) => {
    let out = text;
    for (const [absolute, placeholder] of sorted) {
      for (const form of new Set([absolute, absolute.replaceAll('\\', '/')])) {
        out = out.replaceAll(form, placeholder);
      }
    }
    return out === text
      ? text
      : out.replace(
          /(<[A-Z]+>)([^\s"']*)/g,
          (_, p, rest) => `${String(p)}${String(rest).replaceAll('\\', '/')}`,
        );
  };
  /** @param {unknown} v @returns {unknown} */
  const walk = (v) => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v))
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/**
 * The recording of a PiArc run (`piarc-devcli l3` output).
 * @param {unknown} report
 * @param {string} version
 * @returns {Recording}
 */
export function piarcRecording(report, version) {
  const r = isRecord(report) ? report : {};
  const capture = isRecord(r.capture) ? r.capture : {};
  const requests = isRecord(capture.requests) ? capture.requests : {};
  const logs = isRecord(capture.logs) ? capture.logs : {};
  const turns = Array.isArray(capture.turns) ? capture.turns.filter(isRecord) : [];
  const last = turns.at(-1);
  const workspace = typeof capture.workspace === 'string' ? capture.workspace : '';
  const home = typeof capture.home === 'string' ? capture.home : '';
  /** @type {Recording} */
  const recording = {
    format: FORMAT,
    side: 'piarc',
    version,
    scenario: String(r.id),
    run: {
      exit: null,
      failures: (Array.isArray(r.failures) ? r.failures : [])
        .filter(isRecord)
        .map((f) => String(f.kind)),
    },
    requests: Array.isArray(requests.main) ? requests.main : [],
    trace: {
      tool_calls: Array.isArray(capture.tool_calls) ? capture.tool_calls : [],
      asks: Array.isArray(capture.asks) ? capture.asks : [],
      hooks: Array.isArray(logs['hooks.jsonl']) ? logs['hooks.jsonl'] : [],
      final: { status: last === undefined ? 'failed' : String(last.status) },
      files: /** @type {Record<string, string>} */ (isRecord(capture.files) ? capture.files : {}),
    },
  };
  const root = workspace === '' ? '' : path.dirname(workspace);
  return /** @type {Recording} */ (
    scrubPaths(recording, [
      [workspace, '<WS>'],
      [home, '<HOME>'],
      [root, '<TMP>'],
    ])
  );
}

/**
 * The recording of a Claude Code run (`runClaudeSide` result).
 * @param {Awaited<ReturnType<typeof import('./claude-side.mjs').runClaudeSide>>} capture
 * @param {string} scenario
 * @param {string} version
 * @returns {Recording}
 */
export function claudeRecording(capture, scenario, version) {
  /** @type {Recording} */
  const recording = {
    format: FORMAT,
    side: 'claude-code',
    version,
    scenario,
    run: { exit: capture.exit, failures: capture.exit === 0 ? [] : ['exit'] },
    requests: capture.requests,
    trace: {
      tool_calls: capture.tool_calls,
      asks: capture.asks,
      hooks: capture.hooks,
      final: { status: capture.status },
      files: capture.files,
    },
  };
  return /** @type {Recording} */ (
    scrubPaths(recording, [
      [capture.workspace, '<WS>'],
      [capture.home, '<HOME>'],
      [capture.root, '<TMP>'],
    ])
  );
}
