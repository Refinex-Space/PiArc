import { describe, expect, it } from 'vitest';

import { GHOSTTY_LOCK_PATH, findBuildScriptOutDir, lockEntryFor } from './ghostty-vt.mjs';
import { readJsonFile } from './repo.mjs';

describe('lockEntryFor', () => {
  const lock = readJsonFile(GHOSTTY_LOCK_PATH);

  it('serves the four shipping targets from the committed lock', () => {
    expect(lockEntryFor(lock, 'aarch64-apple-darwin').dll).toBeUndefined();
    expect(lockEntryFor(lock, 'x86_64-apple-darwin').file).toMatch(/xcframework\.zip$/);
    expect(lockEntryFor(lock, 'x86_64-pc-windows-msvc').dll).toMatch(/ghostty-vt\.dll$/);
    expect(lockEntryFor(lock, 'aarch64-pc-windows-msvc').dll).toMatch(/aarch64.*ghostty-vt\.dll$/);
  });

  it('rejects a target without an artefact', () => {
    expect(() => lockEntryFor(lock, 'x86_64-unknown-linux-gnu')).toThrow(/locks no artefact/);
  });
});

describe('findBuildScriptOutDir', () => {
  it('takes the out_dir of the piarc-ghostty-sys build script', () => {
    const output = [
      'not json',
      JSON.stringify({ reason: 'compiler-artifact', package_id: 'path+file:///x#serde@1.0.0' }),
      JSON.stringify({
        reason: 'build-script-executed',
        package_id: 'path+file:///repo/crates/piarc-ghostty-sys#0.0.0',
        out_dir: '/repo/target/debug/build/piarc-ghostty-sys-abc/out',
      }),
      JSON.stringify({ reason: 'build-finished', success: true }),
    ].join('\n');
    expect(findBuildScriptOutDir(output)).toBe(
      '/repo/target/debug/build/piarc-ghostty-sys-abc/out',
    );
  });

  it('fails when cargo did not run the build script', () => {
    expect(() => findBuildScriptOutDir('{"reason":"build-finished"}')).toThrow(/no build script/);
  });
});
