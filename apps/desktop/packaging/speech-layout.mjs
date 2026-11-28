// Voice dictation's bundled assets in a packaged app (ADR-0094, ADR-0095):
//
//   Resources/speech/
//   ├── runtime/   sherpa-onnx C API and ONNX Runtime shared libraries (loaded at run time)
//   └── models/    the streaming model (X-ASR zh-en 480 ms INT8) and Silero VAD
//
// The directory is target/speech-assets/<platform>-<arch>/, which
// scripts/dev/fetch-speech-assets.mjs rebuilds on every package from verified downloads with
// exactly the files of third-party/speech-assets.lock.json (the real-speech test WAVs live
// outside it and are never packaged). scripts/ci/check-app-layout.mjs checks the packaged copy
// against the lock again, and Core verifies sizes and SHA-256 before loading
// (piarc_speech::models).
import { cp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Directory name under the app's resources directory. */
export const SPEECH_DIR = 'speech';

/**
 * Copies the staged speech assets of `platform`-`arch` into `resourcesDir/speech/`.
 * @param {{ repoRoot: string, resourcesDir: string, platform: string, arch: string }} options
 * @returns {Promise<number>} total bytes copied
 */
export async function copySpeechAssets({ repoRoot, resourcesDir, platform, arch }) {
  const source = path.join(repoRoot, 'target', 'speech-assets', `${platform}-${arch}`);
  if (!existsSync(source)) {
    throw new Error(
      `${source} is missing. Run \`node scripts/dev/fetch-speech-assets.mjs\` (package:desktop does).`,
    );
  }
  const destination = path.join(resourcesDir, SPEECH_DIR);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  let bytes = 0;
  for (const name of await readdir(destination, { recursive: true })) {
    const info = await stat(path.join(destination, name));
    if (info.isFile()) bytes += info.size;
  }
  return bytes;
}
