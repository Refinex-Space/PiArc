// Packages the desktop app with `electron-forge package` for one build flavor.
//   node scripts/dev/package-desktop.mjs [--flavor release|development]
// Release is the default. The flavor selects the fuse settings (apps/desktop/fuses.mjs) and
// the output directory apps/desktop/out/<flavor>/.
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import { isMain, repoRoot, resolveBin, run } from '../lib/repo.mjs';

async function main() {
  const { values } = parseArgs({ options: { flavor: { type: 'string' } } });
  const flavor = parseBuildFlavor(values.flavor);
  console.log(`Packaging the desktop app (${flavor} flavor)`);
  process.exitCode = await run(
    process.execPath,
    [resolveBin('@electron-forge/cli', 'electron-forge'), 'package'],
    {
      cwd: path.join(repoRoot, 'apps', 'desktop'),
      env: { ...process.env, PIARC_BUILD_FLAVOR: flavor },
    },
  );
}

if (isMain(import.meta.url)) {
  await main();
}
