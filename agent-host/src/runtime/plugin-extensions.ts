// The Pi extensions of the extension packages in effect (T40, ADR-0058): Core answers
// `plugins/extensions` with the confirmed entry files of the packages the workspace's settings
// turn on, and the session's resource loader gets them as `additionalExtensionPaths`. Pi never
// resolves or installs a package itself (its package manager would run npm with install
// scripts for a missing one). They run in this process, with the agent's permissions; the
// Agent Host's Seatbelt profile still bounds their writes (ADR-0004 rule 4).
import { describeError } from '../protocol/errors.js';
import type { CoreBridge } from './core-bridge.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The entries in Core's answer; a malformed one loads nothing. */
export function parseExtensions(result: unknown): string[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.extensions)) return undefined;
  const paths: string[] = [];
  for (const entry of result.extensions) {
    if (!isRecord(entry) || typeof entry.path !== 'string') return undefined;
    paths.push(entry.path);
  }
  return paths;
}

/** The extension entries for `cwd`; any failure loads none (and says why). */
export async function pluginExtensions(
  bridge: Pick<CoreBridge, 'request'>,
  cwd: string,
  log: (line: string) => void,
): Promise<readonly string[]> {
  try {
    const paths = parseExtensions(await bridge.request('plugins/extensions', { cwd }));
    if (paths === undefined) {
      log('plugins/extensions returned a malformed result: no package extension loads');
      return [];
    }
    return paths;
  } catch (error) {
    log(`plugins/extensions failed, no package extension loads: ${describeError(error)}`);
    return [];
  }
}

/** Whether two lists of entries are the same. */
export function sameExtensions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

/** The sessions whose package extensions differ from what Core answers now. */
export async function changedExtensions<
  S extends {
    readonly extensions?: readonly string[];
    readonly closed: boolean;
    readonly runtime: { readonly session: { readonly sessionManager: { getCwd(): string } } };
  },
>(
  bridge: Pick<CoreBridge, 'request'>,
  sessions: ReadonlyMap<string, S>,
  log: (line: string) => void,
): Promise<[string, S][]> {
  const changed: [string, S][] = [];
  for (const [id, hosted] of [...sessions]) {
    if (hosted.extensions === undefined || hosted.closed) continue;
    const cwd = hosted.runtime.session.sessionManager.getCwd();
    const next = await pluginExtensions(bridge, cwd, log);
    if (!sameExtensions(next, hosted.extensions)) changed.push([id, hosted]);
  }
  return changed;
}
