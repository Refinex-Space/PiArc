// Xcode's ExtensionKit target emits and signs both the executable and its App Intents metadata.
import { execFile } from 'node:child_process';
import { access, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { APP_IDENTIFIER } from '../app-identity.mjs';

/**
 * Install the signed extension after Electron's deep signing pass, before sealing the app.
 * @param {string} repoRoot
 * @param {string} app
 * @param {string} arch Electron Forge target architecture
 */
export async function embedAppIntents(repoRoot, app, arch) {
  const architecture = arch === 'x64' ? 'x86_64' : arch;
  const name = 'PiArcShortcuts';
  const project = path.join(repoRoot, 'apps/desktop/native/app-intents', name + '.xcodeproj');
  const derived = path.join(repoRoot, 'target', 'app-intents', arch);
  await promisify(execFile)(
    'xcrun',
    [
      'xcodebuild',
      '-project',
      project,
      '-scheme',
      name,
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=macOS',
      '-derivedDataPath',
      derived,
      'ARCHS=' + architecture,
      'PIARC_APP_IDENTIFIER=' + APP_IDENTIFIER,
      'build',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const product = path.join(derived, 'Build', 'Products', 'Release', name + '.appex');
  await access(path.join(product, 'Contents/Resources/Metadata.appintents/extract.actionsdata'));
  const directory = path.join(app, 'Contents', 'Extensions');
  await mkdir(directory, { recursive: true });
  await cp(product, path.join(directory, name + '.appex'), {
    recursive: true,
    verbatimSymlinks: true,
  });
}
