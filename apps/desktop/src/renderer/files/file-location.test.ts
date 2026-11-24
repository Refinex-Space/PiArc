import { describe, expect, it } from 'vitest';
import { fileMentionPath, projectPath } from './file-path.js';
import { droppedFiles, FILE_DRAG_TYPE, fileLocation } from './navigation.js';
import { parseMarkdown } from '../transcript/markdown/incremental.js';

describe('project file navigation', () => {
  it('maps a line range into the same checkout, resolving links relative to their document folder', () => {
    expect(fileLocation('./main.ts#L3-L7', '/work/tree', 'packages/app')).toEqual({
      path: 'packages/app/main.ts',
      line: 3,
      endLine: 7,
    });
    expect(fileLocation('../guide.md#L9', '/work/tree', 'docs/start')).toEqual({
      path: 'docs/guide.md',
      line: 9,
    });
    expect(fileLocation('/work/tree/docs/guide.md:7', '/work/tree', 'src')).toEqual({
      path: 'docs/guide.md',
      line: 7,
    });
    expect(fileLocation('d:\\PROJECT\\src\\main.ts#L4', 'D:\\project', 'docs')).toEqual({
      path: 'src/main.ts',
      line: 4,
    });
  });
  it('rejects other roots, relative escapes, unsafe schemes and invalid line numbers', () => {
    for (const path of [
      '/work/tree-other/x',
      '../../outside/file',
      'file:///work/tree/a.md',
      'javascript:x',
      '//host/share',
      'shell:open',
      'a#L99999999999999999999',
      'a#L10-L3',
    ]) {
      expect(fileLocation(path, '/work/tree', 'docs')).toBeUndefined();
    }
    expect(fileLocation('/tmp/a', '')).toBeUndefined();
  });
  it('keeps local links distinct from navigable URLs throughout markdown parsing', () => {
    const block = parseMarkdown(
      '[Overview](docs/my%20guide.md#L4) ![Image](media/a.png) [Danger](javascript:bad) [Site](https://example.org/)',
    )[0];
    if (block?.kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(block.spans).toContainEqual({
      kind: 'link',
      href: null,
      projectTarget: 'docs/my guide.md#L4',
      title: null,
      children: [{ kind: 'text', text: 'Overview' }],
    });
    expect(block.spans).toContainEqual({
      kind: 'image',
      href: null,
      projectTarget: 'media/a.png',
      alt: 'Image',
      title: null,
    });
    expect(block.spans).toContainEqual({
      kind: 'link',
      href: null,
      title: null,
      children: [{ kind: 'text', text: 'Danger' }],
    });
    expect(block.spans).toContainEqual({
      kind: 'link',
      href: 'https://example.org/',
      title: null,
      children: [{ kind: 'text', text: 'Site' }],
    });
  });
});

it('makes project selections refer to the same file from a nested session cwd on both platforms', () => {
  expect(fileMentionPath('src/app/file.ts', { root: '/project', directory: 'src/app' })).toBe(
    'file.ts',
  );
  expect(fileMentionPath('src/another/file.ts', { root: '/project', directory: 'src/app' })).toBe(
    '../another/file.ts',
  );
  expect(fileMentionPath('src/app2/file.ts', { root: 'D:\\checkout', directory: 'src/app' })).toBe(
    '../app2/file.ts',
  );
});

it('claims the project drag type even when a new composer cannot accept this session’s files', () => {
  const data = {
    types: [FILE_DRAG_TYPE],
    getData: () => JSON.stringify({ sessionId: 's', paths: ['a.ts'] }),
  } as unknown as DataTransfer;
  expect(droppedFiles(data, undefined)).toEqual([]);
  expect(droppedFiles(data, 'other')).toEqual([]);
  expect(droppedFiles(data, 's')).toEqual(['a.ts']);
});

it('treats a real filename ending in a line suffix as literal in a tool result', () => {
  expect(projectPath('/project/notes#L9', '/project')).toBe('notes#L9');
  expect(projectPath('/project/notes.txt:42', '/project')).toBe('notes.txt:42');
  expect(projectPath('/project/a:42', '/project')).toBeUndefined();
});

it('disables names in a Windows alternate stream without hiding ordinary POSIX colon filenames', () => {
  expect(projectPath('D:\\checkout\\notes.txt:stream', 'D:\\checkout')).toBeUndefined();
  expect(projectPath('/checkout/notes.txt:stream', '/checkout')).toBe('notes.txt:stream');
});
