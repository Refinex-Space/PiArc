import { expect, it } from 'vitest';
import { closeFiles, selectFile, type FileTabs } from './file-tabs.js';
it('replaces only the temporary preview and keeps a pinned or edited file when reopening a different file', () => {
  const initial: FileTabs = { paths: [], active: null, preview: null };
  const first = selectFile(initial, 'README.md', true);
  const second = selectFile(first, 'src/first.ts', false);
  const third = selectFile(second, 'src/second.ts', false);
  expect(third.paths).toEqual(['README.md', 'src/second.ts']);
  const keep = selectFile(third, 'src/second.ts', true);
  const another = selectFile(keep, 'src/third.ts', false);
  expect(another.paths).toEqual(['README.md', 'src/second.ts', 'src/third.ts']);
  expect(closeFiles(another, ['src/third.ts'])).toEqual({ ...keep, active: 'src/second.ts' });
});
