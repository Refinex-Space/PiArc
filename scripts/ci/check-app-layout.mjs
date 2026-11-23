// Checks a packaged desktop app against the layout of architecture section 5.6 and, on
// macOS, the signing layers of ADR-0018 rule 2 (apps/desktop/packaging/macos-sign.mjs).
//
// Usage: node scripts/ci/check-app-layout.mjs [--flavor release|development] [--arch <arch>]
//                                              [--app <path>] [--json <file>]
//   --app   the .app bundle on macOS, the directory with PiArc.exe on Windows
//           (default: apps/desktop/out/<flavor>/PiArc-<platform>-<arch>/…)
//   --json  also writes every check with its evidence (codesign output) to <file>
//
// Checks:
// - No development-only binary (piarc-devcli, piarc-mock-provider) is anywhere in the app or
//   in app.asar (architecture section 7.1: they never ship).
// - Resources/agent-host/ holds node, npm, npx, the bundle, pi-assets/package.json, the
//   bundle's external packages, rg and fd, as real files outside app.asar; app.asar holds none
//   of them; the Core module is in app.asar.unpacked/native/.
// - macOS: `codesign --verify --deep --strict` passes for the app; the app is ad-hoc signed
//   with the hardened runtime and exactly the entitlements of entitlements.mac.plist; node
//   keeps the Node.js Foundation's Developer ID signature; rg, fd and the Core module are
//   ad-hoc signed.
// Exit code 0 when every check passes.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { listPackage } from '@electron/asar';

import { APP_IDENTIFIER } from '../../apps/desktop/app-identity.mjs';
import { coreBinaryName } from '../../apps/desktop/core-binary.mjs';
import { parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import {
  AGENT_HOST_DIR,
  AGENT_HOST_EXTERNALS,
  agentHostLayout,
} from '../../apps/desktop/packaging/agent-host-layout.mjs';
import { ENTITLEMENTS } from '../../apps/desktop/packaging/macos-sign.mjs';
import {
  CHUNK_DIR,
  entrySource,
  verifiedBundle,
} from '../../apps/desktop/packaging/agent-bundle.mjs';
import { isMain, isRecord, readJsonFile } from '../lib/repo.mjs';
import { packagedAppPath, productName } from './check-fuses.mjs';

/** Team identifier of the Node.js Foundation's Developer ID certificate. */
export const NODE_TEAM_ID = 'HX7739G8FX';

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 * @typedef {{ identifier?: string, flags: string[], adhoc: boolean, teamId?: string,
 *   authorities: string[] }} SignatureInfo
 */

/**
 * Parses the output of `codesign -dvv <path>` (it prints to stderr).
 * @param {string} output
 * @returns {SignatureInfo}
 */
export function parseCodesignDisplay(output) {
  const value = (/** @type {string} */ key) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1]?.trim();
  const flagsMatch = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(output);
  const flags = flagsMatch?.[1] ? flagsMatch[1].split(',').filter((f) => f !== '') : [];
  const teamId = value('TeamIdentifier');
  const identifier = value('Identifier');
  return {
    ...(identifier === undefined ? {} : { identifier }),
    flags,
    adhoc: flags.includes('adhoc') || value('Signature') === 'adhoc',
    ...(teamId === undefined || teamId === 'not set' ? {} : { teamId }),
    authorities: [...output.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]?.trim() ?? ''),
  };
}

/**
 * Entitlement keys in a plist (XML) document.
 * @param {string} xml
 * @returns {string[]}
 */
export function entitlementKeys(xml) {
  return [...xml.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)].map((m) => m[1] ?? '').sort();
}

/**
 * @param {string[]} args
 * @returns {{ code: number, output: string }}
 */
function codesign(args) {
  const result = spawnSync('codesign', args, { encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** @param {string} file */
function signatureOf(file) {
  const { code, output } = codesign(['-dvv', file]);
  return { code, output, info: parseCodesignDisplay(output) };
}

/** Development-only binaries of the Rust workspace that must never ship. */
export const DEV_TOOLS = ['piarc-devcli', 'piarc-mock-provider'];

/**
 * The paths among `paths` whose file name is a development-only binary (any extension).
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function findDevTools(paths) {
  return paths.filter((p) => {
    const name = p.split(/[\\/]/).pop() ?? '';
    return DEV_TOOLS.some((tool) => name === tool || name.startsWith(`${tool}.`));
  });
}

/**
 * Every file and directory below `dir`, without following symbolic links.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((p) => path.join(dir, p));
}

/**
 * Whether the Core module at `file` has the development build's testing exports; undefined when
 * this Node cannot load it (another architecture).
 * @param {string} file
 * @param {string} arch
 * @returns {boolean | undefined}
 */
export function testingExports(file, arch) {
  if (arch !== process.arch) return undefined;
  /** @type {unknown} */
  const loaded = createRequire(import.meta.url)(file);
  const runtime =
    typeof loaded === 'object' && loaded !== null && 'CoreRuntime' in loaded
      ? loaded.CoreRuntime
      : undefined;
  const prototype =
    typeof runtime === 'function' && typeof runtime.prototype === 'object'
      ? /** @type {object} */ (runtime.prototype)
      : {};
  return 'startDemoSource' in prototype && 'triggerPanic' in prototype;
}

/**
 * The renderer chunks that hold the test pages (`src/renderer/test-pages.tsx`).
 * @param {readonly string[]} paths paths inside app.asar
 * @returns {string[]}
 */
export function testPageChunks(paths) {
  return paths.filter((p) => /[\\/]test-pages-[^\\/]*\.js$/.test(p));
}

/**
 * Runs every check against one packaged app; with `flavor`, also whether its Core has the
 * testing exports that flavor should (or should not) have.
 * @param {{ app: string, platform: string, arch: string, flavor?: string }} options
 * @returns {Check[]}
 */
export function checkAppLayout({ app, platform, arch, flavor }) {
  /** @type {Check[]} */
  const checks = [];
  const add = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = '') =>
    checks.push({ name, ok, detail });
  const resources =
    platform === 'darwin' ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources');
  const agentHost = path.join(resources, AGENT_HOST_DIR);
  const layout = agentHostLayout(platform);

  const files = /** @type {Array<[string, string]>} */ ([
    ['node', layout.node],
    ['npm', layout.npm],
    ['npx', layout.npx],
    ['bundle', layout.bundle],
    ['pi-assets/package.json', layout.piPackageJson],
    ['rg', layout.rg],
    ['fd', layout.fd],
    ...AGENT_HOST_EXTERNALS.map(
      (name) =>
        /** @type {[string, string]} */ ([
          name,
          path.join(layout.nodeModules, name, 'package.json'),
        ]),
    ),
  ]);
  for (const [label, relative] of files) {
    const full = path.join(agentHost, relative);
    add(`agent-host/${label} present outside app.asar`, existsSync(full), full);
  }
  try {
    const manifest = verifiedBundle(agentHost);
    const entry = readFileSync(path.join(agentHost, layout.bundle), 'utf8');
    const count = Object.keys(manifest.files).length;
    add(
      'Agent Host ESM chunks',
      entry === entrySource(manifest.entry) &&
        readdirSync(path.join(agentHost, CHUNK_DIR)).length === count,
      String(count),
    );
  } catch (error) {
    add('Agent Host ESM chunks', false, String(error));
  }
  const asar = path.join(resources, 'app.asar');
  const inAsar = existsSync(asar)
    ? listPackage(asar, { isPack: false }).filter((p) =>
        /agent-host\.mjs|[\\/]agent-host[\\/]chunks[\\/]|[\\/]rg(\.exe)?$|[\\/]fd(\.exe)?$/.test(p),
      )
    : ['app.asar missing'];
  add('app.asar holds no Agent Host resources', inAsar.length === 0, inAsar.join(', '));
  const devTools = findDevTools([
    ...walk(app),
    ...(existsSync(asar) ? listPackage(asar, { isPack: false }) : []),
  ]);
  add(
    'no development tools (piarc-devcli, piarc-mock-provider)',
    devTools.length === 0,
    devTools.join(', '),
  );
  const core = path.join(resources, 'app.asar.unpacked', 'native', coreBinaryName(platform, arch));
  add('Core module in app.asar.unpacked/native/', existsSync(core), core);
  if (flavor !== undefined && existsSync(core)) {
    const testing = testingExports(core, arch);
    if (testing !== undefined) {
      // The main process installs its test hooks (among them the answer to the extension
      // packages' native confirmation, T40) only for a Core with testing exports.
      add(
        flavor === 'release'
          ? 'release Core has no testing exports (no test hooks, no answers to native confirmations)'
          : 'development Core has testing exports',
        testing === (flavor !== 'release'),
        `testing exports: ${String(testing)}`,
      );
    }
  }

  if (flavor !== undefined && existsSync(asar)) {
    // The renderer's test pages (event probe, transcript and terminal prototypes) are a chunk
    // of their own that only the development flavor emits (T45, I13, I24, I30).
    const pages = testPageChunks(listPackage(asar, { isPack: false }));
    add(
      flavor === 'release'
        ? 'release renderer has no test pages'
        : 'development renderer has the test pages',
      (pages.length === 0) === (flavor === 'release'),
      pages.join(', ') || 'none',
    );
  }

  if (platform !== 'darwin') {
    return checks;
  }
  const verify = codesign(['--verify', '--deep', '--strict', '--verbose=1', app]);
  add('codesign --verify --deep --strict (app)', verify.code === 0, verify.output.trim());

  const extension = path.join(app, 'Contents', 'Extensions', 'PiArcShortcuts.appex');
  const extensionSignature = signatureOf(extension);
  add(
    'App Intents extension: signed for the host app',
    extensionSignature.info.identifier === APP_IDENTIFIER + '.shortcuts' &&
      extensionSignature.info.adhoc &&
      codesign(['--verify', '--strict', extension]).code === 0,
    extensionSignature.output.trim(),
  );
  const metadata = path.join(
    extension,
    'Contents/Resources/Metadata.appintents/extract.actionsdata',
  );
  const contents = existsSync(metadata) ? readJsonFile(metadata) : undefined;
  const actions = isRecord(contents) && isRecord(contents.actions) ? contents.actions : {};
  for (const id of ['OpenPiArc', 'OpenWorkspace', 'NewSession']) {
    const action = actions[id];
    add(
      `App Intents extension: ${id} discoverable metadata`,
      isRecord(action) && action.isDiscoverable === true,
      metadata,
    );
  }

  const appSig = signatureOf(app);
  add('app: ad-hoc signature', appSig.info.adhoc, appSig.output.trim());
  add('app: hardened runtime', appSig.info.flags.includes('runtime'), appSig.info.flags.join(','));
  const entitlements = codesign(['-d', '--entitlements', '-', '--xml', app]);
  const expected = entitlementKeys(readFileSync(ENTITLEMENTS, 'utf8'));
  const actual = entitlementKeys(entitlements.output);
  add(
    'app: entitlements match entitlements.mac.plist',
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual: ${actual.join(', ')}; expected: ${expected.join(', ')}`,
  );

  const node = path.join(agentHost, layout.node);
  const nodeSig = signatureOf(node);
  add(
    'node: Node.js Foundation signature kept',
    !nodeSig.info.adhoc &&
      nodeSig.info.teamId === NODE_TEAM_ID &&
      nodeSig.info.authorities.some((a) =>
        a.startsWith('Developer ID Application: Node.js Foundation'),
      ),
    nodeSig.output.trim(),
  );
  const nodeVerify = codesign(['--verify', '--strict', '--verbose=1', node]);
  add('node: codesign --verify --strict', nodeVerify.code === 0, nodeVerify.output.trim());

  for (const [label, file] of /** @type {Array<[string, string]>} */ ([
    ['rg', path.join(agentHost, layout.rg)],
    ['fd', path.join(agentHost, layout.fd)],
    ['Core module', core],
  ])) {
    const sig = signatureOf(file);
    const ok =
      sig.code === 0 && sig.info.adhoc && codesign(['--verify', '--strict', file]).code === 0;
    add(`${label}: ad-hoc signature`, ok, sig.output.trim());
  }
  // npm's bin links must stay relative, or they would point into the build machine.
  for (const link of [layout.npm, layout.npx]) {
    const full = path.join(agentHost, link);
    const isLink = existsSync(full) && lstatSync(full).isSymbolicLink();
    add(`${link} is a relative link inside the app`, isLink && existsSync(full), full);
  }
  return checks;
}

function main() {
  const { values } = parseArgs({
    options: {
      flavor: { type: 'string' },
      arch: { type: 'string', default: process.arch },
      app: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const flavor = parseBuildFlavor(values.flavor);
  const platform = process.platform;
  const executable = packagedAppPath(flavor, productName(), platform, values.arch);
  const app = values.app ?? (platform === 'darwin' ? executable : path.dirname(executable));
  if (!existsSync(app)) {
    console.error(`Packaged app not found: ${app}`);
    process.exitCode = 1;
    return;
  }
  const checks = checkAppLayout({ app, platform, arch: values.arch, flavor });
  console.log(`Layout and signatures of ${app}`);
  for (const check of checks) {
    console.log(`  ${check.ok ? '✔' : '✖'} ${check.name}`);
    if (!check.ok) {
      console.log(`      ${check.detail.split('\n').join('\n      ')}`);
    }
  }
  if (values.json !== undefined) {
    writeFileSync(
      values.json,
      `${JSON.stringify({ app, flavor, arch: values.arch, checks }, null, 2)}\n`,
    );
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? `All ${String(checks.length)} checks passed.`
      : `${String(failed)} check(s) failed.`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main();
}
