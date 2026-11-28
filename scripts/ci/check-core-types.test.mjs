import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sameDeclarations } from './check-core-types.mjs';

/** @type {string[]} */
const dirs = [];

/**
 * Creates a directory (path with a space and Chinese characters) holding the given files.
 * @param {Record<string, string>} files
 */
async function makeDir(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'core types 测试-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('sameDeclarations', () => {
  const file = 'piarc-core.d.ts';

  it('accepts identical declarations', async () => {
    const content = 'export declare class CoreRuntime {}\n';
    expect(
      await sameDeclarations(
        await makeDir({ [file]: content }),
        await makeDir({ [file]: content }),
        file,
      ),
    ).toBe(true);
  });

  it('reports a changed signature', async () => {
    const committed = await makeDir({ [file]: 'echo(route: string): void\n' });
    const fresh = await makeDir({ [file]: 'echo(route: string, payload: string): void\n' });
    expect(await sameDeclarations(committed, fresh, file)).toBe(false);
  });

  it('reports a snapshot that was never committed', async () => {
    const committed = await makeDir({});
    const fresh = await makeDir({ [file]: 'export {};\n' });
    expect(await sameDeclarations(committed, fresh, file)).toBe(false);
  });
});
