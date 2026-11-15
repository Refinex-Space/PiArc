import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mutationKey, readPathCandidates, resolveToolPath } from './paths.js';
import { serialized, StandIn } from './stand-in.js';

const cwd = path.resolve('/work space/项目');

describe('resolveToolPath', () => {
  it('resolves like Pi: relative to cwd, @ prefix, unicode spaces, ~ and file URLs', () => {
    expect(resolveToolPath('src/a.ts', cwd)).toBe(path.join(cwd, 'src', 'a.ts'));
    expect(resolveToolPath('@src/a.ts', cwd)).toBe(path.join(cwd, 'src', 'a.ts'));
    expect(resolveToolPath('a b.txt', cwd)).toBe(path.join(cwd, 'a b.txt'));
    expect(resolveToolPath('../x/./y', cwd)).toBe(path.resolve(cwd, '..', 'x', 'y'));
    expect(resolveToolPath('~/notes.md', cwd)).toBe(path.join(homedir(), 'notes.md'));
    expect(resolveToolPath('~', cwd)).toBe(homedir());
    const absolute = path.resolve('/etc/hosts');
    expect(resolveToolPath(absolute, cwd)).toBe(absolute);
    if (process.platform !== 'win32') {
      expect(resolveToolPath('file:///tmp/a%20b.txt', cwd)).toBe('/tmp/a b.txt');
    }
  });
});

describe('readPathCandidates', () => {
  it('lists the spellings macOS uses after the path itself, without repeats', () => {
    const screenshot = '/s/Screen Shot 2026-11-15 at 9.41.02 AM.png';
    expect(readPathCandidates(screenshot)).toEqual([
      screenshot,
      '/s/Screen Shot 2026-11-15 at 9.41.02 AM.png',
    ]);
    const french = "/s/Capture d'écran.png";
    const candidates = readPathCandidates(french);
    expect(candidates[0]).toBe(french);
    expect(candidates).toContain(french.normalize('NFD'));
    expect(candidates).toContain('/s/Capture d’écran.png');
    expect(candidates).toContain('/s/Capture d’écran.png'.normalize('NFD'));
    expect(readPathCandidates('/plain.txt')).toEqual(['/plain.txt']);
  });

  it('serializes writes per file, case-insensitively on Windows', () => {
    expect(mutationKey('/A/b')).toBe(process.platform === 'win32' ? '/a/b' : '/A/b');
  });
});

describe('StandIn', () => {
  it('maps the stand-in and its directory to the real path and restores spellings', () => {
    const real = path.join(cwd, 'notes', 'a.txt');
    const standIn = new StandIn(real);
    expect(standIn.path.startsWith(cwd)).toBe(false);
    expect(path.basename(standIn.path)).toBe('a.txt');
    expect(standIn.resolve(standIn.path)).toBe(real);
    expect(standIn.resolve(path.dirname(standIn.path))).toBe(path.dirname(real));
    expect(() => standIn.resolve(real)).toThrow(/unexpected path/);
    const result = {
      content: [{ type: 'text', text: `Successfully wrote to ${standIn.path}` }],
      details: { diff: `--- ${standIn.path}\n+++ ${standIn.path}` },
    };
    expect(standIn.restore(result, 'notes/a.txt')).toEqual({
      content: [{ type: 'text', text: 'Successfully wrote to notes/a.txt' }],
      details: { diff: '--- notes/a.txt\n+++ notes/a.txt' },
    });
    const restored = standIn.restoreError(
      new Error(`Could not edit file: ${standIn.path}. Error code: ENOENT.`),
      'notes/a.txt',
    );
    expect(restored).toBeInstanceOf(Error);
    expect((restored as Error).message).toBe(
      'Could not edit file: notes/a.txt. Error code: ENOENT.',
    );
  });

  it('runs operations on one key one after another', async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<undefined>();
    const first = serialized('k', async () => {
      order.push('first start');
      await gate.promise;
      order.push('first end');
    });
    const second = serialized('k', () => {
      order.push('second');
      return Promise.resolve();
    });
    const other = serialized('other', () => {
      order.push('other');
      return Promise.resolve();
    });
    await other;
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'other', 'first end', 'second']);
  });
});
