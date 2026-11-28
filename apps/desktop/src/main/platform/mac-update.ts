// Installing a downloaded update on macOS (ADR-0111 rule 5). PiArc is ad-hoc signed, so
// Electron's updater (Squirrel.Mac) does not apply: the main process replaces its own bundle.
//
// 1. `replaceable`: the bundle is not under App Translocation's random path and its folder is
//    writable; otherwise the update is installed by hand (the About page explains why).
// 2. `stageMacUpdate`: `ditto -x -k` extracts Core's verified ZIP next to the bundle (same
//    volume, so the swap is a rename) and the extracted Info.plist must name the app's
//    identifier and the target version.
// 3. `startSwap`: a detached `/bin/sh` helper waits for PiArc to exit, moves the old bundle
//    aside, moves the new one in (restoring the old one on failure), opens it and removes the
//    old one. Every value is a separate argument; nothing is put into the script text.
import path from 'node:path';

/** Runs a program; resolves with its exit code and stdout. */
export type RunProgram = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string }>;

export interface MacInstallPorts {
  readonly run: RunProgram;
  /** Whether `target` can be written by this process. */
  readonly writable: (target: string) => Promise<boolean>;
  readonly removeDir: (dir: string) => Promise<void>;
  readonly makeDir: (dir: string) => Promise<void>;
  readonly writeFile: (file: string, text: string) => Promise<void>;
  /** Starts `command args` detached, its output appended to `log`. */
  readonly spawnDetached: (command: string, args: readonly string[], log: string) => void;
}

/** Why the bundle cannot be replaced in place. */
export type NotReplaceable = 'notBundle' | 'translocated' | 'notWritable';

/** The `.app` bundle holding `executable` (`…/PiArc.app/Contents/MacOS/PiArc`). */
export function bundleOf(executable: string): string | undefined {
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (
    path.basename(macos) !== 'MacOS' ||
    path.basename(contents) !== 'Contents' ||
    !bundle.endsWith('.app')
  ) {
    return undefined;
  }
  return bundle;
}

/** Whether `bundle` can be swapped for a new one in place. */
export async function replaceable(
  bundle: string | undefined,
  writable: MacInstallPorts['writable'],
): Promise<NotReplaceable | undefined> {
  if (bundle === undefined) return 'notBundle';
  if (bundle.split(path.sep).includes('AppTranslocation')) return 'translocated';
  if (!(await writable(path.dirname(bundle))) || !(await writable(bundle))) return 'notWritable';
  return undefined;
}

/** The staging folder next to `bundle` for `version`. */
export function stagingDir(bundle: string, version: string): string {
  return path.join(path.dirname(bundle), `.${path.basename(bundle)}.update-${version}`);
}

async function plistValue(run: RunProgram, plist: string, key: string): Promise<string> {
  const { code, stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  if (code !== 0) throw new Error(`the update's Info.plist has no ${key}`);
  return stdout.trim();
}

/**
 * Extracts `archive` next to `bundle` and checks the new bundle's identity. Answers the path
 * of the new bundle.
 */
export async function stageMacUpdate(
  ports: MacInstallPorts,
  options: {
    readonly archive: string;
    readonly bundle: string;
    readonly version: string;
    readonly identifier: string;
  },
): Promise<string> {
  const staging = stagingDir(options.bundle, options.version);
  await ports.removeDir(staging);
  await ports.makeDir(staging);
  const extracted = await ports.run('/usr/bin/ditto', ['-x', '-k', options.archive, staging]);
  if (extracted.code !== 0) {
    await ports.removeDir(staging);
    throw new Error(
      `the update could not be extracted (ditto exited with ${String(extracted.code)})`,
    );
  }
  const app = path.join(staging, path.basename(options.bundle));
  const plist = path.join(app, 'Contents', 'Info.plist');
  try {
    const identifier = await plistValue(ports.run, plist, 'CFBundleIdentifier');
    const version = await plistValue(ports.run, plist, 'CFBundleShortVersionString');
    if (identifier !== options.identifier) {
      throw new Error(`the update is ${identifier}, not ${options.identifier}`);
    }
    if (version !== options.version) {
      throw new Error(`the update is version ${version}, not ${options.version}`);
    }
  } catch (error) {
    await ports.removeDir(staging);
    throw error;
  }
  return app;
}

/**
 * The helper: `$1` PiArc's pid, `$2` the new bundle, `$3` the bundle to replace, `$4` the
 * staging folder. It waits at most 60 s for PiArc to exit.
 */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; target="$3"; staging="$4"
backup="$target.piarc-old"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -ge 600 ]; then echo "PiArc did not exit; the update is not installed"; exit 1; fi
  sleep 0.1
done
rm -rf "$backup"
if ! mv "$target" "$backup"; then
  echo "cannot move the installed app aside"; open "$target"; exit 1
fi
if ! mv "$new" "$target"; then
  echo "cannot move the new app into place; restoring the installed one"
  mv "$backup" "$target"; open "$target"; exit 1
fi
open "$target"
rm -rf "$backup" "$staging"
echo "updated $target"
`;

/** Writes the helper into the staging folder and starts it; PiArc must exit next. */
export async function startSwap(
  ports: MacInstallPorts,
  options: {
    readonly pid: number;
    readonly app: string;
    readonly bundle: string;
    readonly log: string;
  },
): Promise<void> {
  const staging = path.dirname(options.app);
  const script = path.join(staging, 'swap.sh');
  await ports.writeFile(script, SWAP_SCRIPT);
  ports.spawnDetached(
    '/bin/sh',
    [script, String(options.pid), options.app, options.bundle, staging],
    options.log,
  );
}
