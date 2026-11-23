// A packaged host must still be able to load code first used after the handshake.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { checkAppLayout } from './check-app-layout.mjs';
import { copyAgentHostResources } from '../../apps/desktop/packaging/agent-host-layout.mjs';

it('ships late imports, excludes old chunks and detects a missing or changed packaged chunk', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'piarc bundle '));
  const app = path.join(repoRoot, 'app');
  const resourcesDir = path.join(app, 'resources');
  const bundle = path.join(repoRoot, 'agent-host/dist/bundle');
  const runtime = path.join(repoRoot, 'target/agent-host-runtime/win32-x64');
  const entry = 'entry-ABC12345.mjs';
  const late = 'chunk-DEF12345.mjs';
  const modules = {
    [entry]: `if (process.argv.includes('--late')) console.log((await import('./${late}')).answer);\n`,
    [late]: 'export const answer = 42;\n',
  };
  const files = Object.fromEntries(
    Object.entries(modules).map(([name, code]) => [
      name,
      createHash('sha256').update(code).digest('hex'),
    ]),
  );
  try {
    for (const [file, contents] of [
      [path.join(runtime, 'node/node.exe'), 'node'],
      [path.join(runtime, 'bin/rg.exe'), 'rg'],
      [path.join(runtime, 'bin/fd.exe'), 'fd'],
      [path.join(bundle, 'pi-assets/package.json'), '{}'],
      [path.join(repoRoot, 'node_modules/@silvia-odwyer/photon-node/package.json'), '{}'],
      [path.join(bundle, 'agent-host.mjs'), `import "./chunks/${entry}";\n`],
      [path.join(bundle, 'bundle-files.json'), JSON.stringify({ entry, files })],
      [path.join(bundle, 'chunks', entry), modules[entry]],
      [path.join(bundle, 'chunks', late), modules[late]],
      [path.join(bundle, 'chunks/chunk-OLD12345.mjs'), 'unused'],
    ]) {
      if (file === undefined || contents === undefined) throw new Error('invalid fixture');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const target = await copyAgentHostResources({
      repoRoot,
      resourcesDir,
      platform: 'win32',
      arch: 'x64',
    });
    const installed = path.join(target, 'chunks', late);
    expect(await readFile(installed, 'utf8')).toBe(modules[late]);
    await expect(readFile(path.join(target, 'chunks/chunk-OLD12345.mjs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      execFileSync(process.execPath, [path.join(target, 'agent-host.mjs'), '--late'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('42');
    const valid = () =>
      checkAppLayout({ app, platform: 'win32', arch: 'x64' }).find(
        (check) => check.name === 'Agent Host ESM chunks',
      )?.ok;
    expect(valid()).toBe(true);
    await writeFile(installed, 'different bytes');
    expect(valid()).toBe(false);
    await rm(installed);
    expect(valid()).toBe(false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
