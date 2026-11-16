// Ad-hoc code signing of the packaged macOS app (ADR-0018 rule 2, architecture section 10.3).
//
// Layers, inside out:
// 1. Electron's own code (frameworks, helpers, main executable) is re-signed with one `--deep`
//    pass, with the hardened runtime and entitlements.mac.plist, before the Agent Host
//    resources are copied in: writing fuses invalidated the signature, and the fuses plugin's
//    own reset only runs for arm64.
// 2. Every other Mach-O file under Contents/Resources (the Core `.node`, rg, fd) gets its own
//    ad-hoc signature, except the bundled Node, which keeps the Node.js Foundation's
//    Developer ID signature: re-signing it would drop the notarisation it carries.
// 3. The app bundle is signed last without `--deep`, which seals Resources/ (including the
//    Agent Host files) in CodeResources and leaves the nested signatures as they are.
//
// Hardened runtime: on, with `allow-jit` and `disable-library-validation` (S6 report section
// 3). Ad-hoc signatures have no Team ID, so library validation would reject Electron Framework;
// the runtime still blocks DYLD_* injection and debugger attachment, which protects the
// keychain grant that belongs to the app's code identity.
import { open, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Mach-O and universal-binary magic numbers, as the first four bytes read big-endian. */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
function exec(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

/**
 * Runs codesign and fails with its output.
 * @param {string[]} args
 */
async function codesign(args) {
  const { code, output } = await exec('codesign', args);
  if (code !== 0) {
    throw new Error(`codesign ${args.join(' ')} failed (${String(code)}):\n${output}`);
  }
}

/**
 * True when `file` starts with a Mach-O or universal-binary header.
 * @param {string} file
 */
export async function isMachO(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGICS.has(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/**
 * Regular Mach-O files under `dir`, skipping symlinks and the directories in `exclude`.
 * @param {string} dir
 * @param {ReadonlySet<string>} exclude absolute directories to skip
 * @returns {Promise<string[]>}
 */
export async function findMachOFiles(dir, exclude) {
  /** @type {string[]} */
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.has(full)) {
        found.push(...(await findMachOFiles(full, exclude)));
      }
    } else if (entry.isFile() && (await isMachO(full))) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Entitlements of the app's own code under the hardened runtime. */
export const ENTITLEMENTS = fileURLToPath(new URL('entitlements.mac.plist', import.meta.url));

const HARDENED = ['--options', 'runtime', '--entitlements', ENTITLEMENTS];

/**
 * Step 1: re-signs Electron's code after fuses were written. Run before anything else is
 * copied into the bundle.
 * @param {string} appPath `…/PiArc.app`
 */
export async function resealElectron(appPath) {
  await codesign(['--sign', '-', '--force', ...HARDENED, '--deep', appPath]);
}

/**
 * Steps 2 and 3: signs every Mach-O file in Contents/Resources except those under
 * `keepSigned` (the bundled Node), then the bundle itself without `--deep`.
 * @param {string} appPath
 * @param {{ keepSigned: string[] }} options absolute directories whose signatures stay
 * @returns {Promise<string[]>} the files that were signed in step 2
 */
export async function signResourcesAndBundle(appPath, { keepSigned }) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const files = await findMachOFiles(resources, new Set(keepSigned));
  for (const file of files) {
    await codesign(['--sign', '-', '--force', file]);
  }
  await signBundle(appPath);
  return files;
}

/**
 * Step 3 alone: (re)signs the bundle itself without `--deep`, leaving nested signatures.
 * @param {string} appPath
 */
export async function signBundle(appPath) {
  await codesign(['--sign', '-', '--force', ...HARDENED, appPath]);
}
