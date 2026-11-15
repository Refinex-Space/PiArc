import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_DIR, SCHEMA_DIR } from '../dev/gen-protocol.mjs';
import { diffGenerated } from './check-protocol-drift.mjs';

/** @type {string[]} */
const roots = [];

/**
 * Creates a root (path with a space and Chinese characters) holding the given files.
 * @param {Record<string, string>} files paths relative to the root
 */
async function makeRoot(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drift 测试-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('diffGenerated', () => {
  const schema = path.join(SCHEMA_DIR, 'ahp.schema.json');
  const types = path.join(GENERATED_DIR, 'ahp.ts');

  it('reports nothing when both roots hold identical files', async () => {
    const files = { [schema]: '{}\n', [types]: 'export {};\n' };
    const result = await diffGenerated(await makeRoot(files), await makeRoot(files));
    expect(result).toEqual({ changed: [], missing: [], stale: [] });
  });

  it('reports changed, missing and stale files', async () => {
    const committed = await makeRoot({
      [schema]: '{}\n',
      [path.join(GENERATED_DIR, 'old.ts')]: 'export {};\n',
    });
    const fresh = await makeRoot({ [schema]: '{ "a": 1 }\n', [types]: 'export {};\n' });
    expect(await diffGenerated(committed, fresh)).toEqual({
      changed: [schema],
      missing: [types],
      stale: [path.join(GENERATED_DIR, 'old.ts')],
    });
  });

  it('treats a line-ending difference as a change', async () => {
    const committed = await makeRoot({ [schema]: '{}\r\n' });
    const fresh = await makeRoot({ [schema]: '{}\n' });
    expect((await diffGenerated(committed, fresh)).changed).toEqual([schema]);
  });
});
