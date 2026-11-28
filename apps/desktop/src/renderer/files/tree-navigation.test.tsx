// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cancelProjectSearch,
  listProjectFiles,
  searchProjectFiles,
  type ProjectEntry,
  type ProjectMatch,
} from './api.js';
import { useDirectories } from './tree-directories.js';
import { treeRows } from './tree-model.js';
import { DEFAULT_SEARCH, useProjectSearch } from './tree-search.js';

vi.mock('./api.js', () => ({
  listProjectFiles: vi.fn(),
  cancelProjectSearch: vi.fn(),
  searchProjectFiles: vi.fn(),
}));

function deferred<T>() {
  let done: (value: T) => void = () => {
    throw new Error('Promise is not ready');
  };
  const promise = new Promise<T>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: done };
}

async function settle(action: () => void | Promise<void>) {
  await act(async () => {
    await action();
  });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('cancels superseded content searches and ignores out-of-order responses', async () => {
  vi.useFakeTimers();
  const first = deferred<{ results: ProjectMatch[]; truncated: boolean }>();
  const newer = deferred<{ results: ProjectMatch[]; truncated: boolean }>();
  vi.mocked(searchProjectFiles)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(newer.promise);
  vi.mocked(cancelProjectSearch).mockResolvedValue(undefined);
  function Search({ query }: { query: string }) {
    const result = useProjectSearch('session', query, DEFAULT_SEARCH, 0);
    return (
      <span>
        {result.phase}
        {result.results[0]?.path}
      </span>
    );
  }
  await settle(() => {
    root.render(<Search query="?first" />);
  });
  await settle(() => vi.advanceTimersByTimeAsync(150).then(() => undefined));
  const started = vi.mocked(searchProjectFiles).mock.calls[0];
  expect(started?.[1]).toMatchObject({ query: 'first', mode: 'content' });
  await settle(() => {
    root.render(<Search query="?second" />);
  });
  expect(cancelProjectSearch).toHaveBeenCalledWith('session', started?.[1].searchId);
  await settle(() => vi.advanceTimersByTimeAsync(150).then(() => undefined));
  await settle(() => {
    newer.resolve({
      results: [{ kind: 'file', name: 'second', path: 'second' }],
      truncated: false,
    });
  });
  expect(host.textContent).toBe('readysecond');
  await settle(() => {
    first.resolve({ results: [{ kind: 'file', name: 'first', path: 'first' }], truncated: false });
  });
  expect(host.textContent).toBe('readysecond');
});

it('includes a previously capped child when revealing it and refreshes only visible folders', async () => {
  const leaf: ProjectEntry = { name: 'found', path: 'z/found', kind: 'file' };
  const folder: ProjectEntry = { name: 'z', path: 'z', kind: 'directory' };
  const list = vi.mocked(listProjectFiles);
  list.mockImplementation((_session, relative, includeChild) =>
    Promise.resolve(
      relative === 'z'
        ? { entries: [leaf], truncated: false }
        : { entries: includeChild === 'z' ? [folder] : [], truncated: true },
    ),
  );
  function Browser({ revision }: { revision: number }) {
    const tree = useDirectories('session', revision);
    return (
      <>
        <button onClick={() => void tree.reveal(leaf.path)} />
        <span>
          {treeRows(tree.pages, tree.expanded)
            .map((row) => row.id)
            .join(',')}
        </span>
      </>
    );
  }
  await settle(() => {
    root.render(<Browser revision={0} />);
  });
  expect(list.mock.calls.map((call) => call[1])).toEqual(['']);
  await settle(() => {
    host.querySelector('button')?.click();
  });
  expect(host.textContent).toContain('z/found');
  expect(list).toHaveBeenCalledWith('session', '', 'z');
  list.mockClear();
  await settle(() => {
    root.render(<Browser revision={1} />);
  });
  expect(list.mock.calls.map((call) => call[1])).toEqual(['', 'z']);
  expect(host.textContent).toContain('z/found');
});

it('restores the expanded folder for the same workspace session after switching panes', async () => {
  const parent: ProjectEntry = { path: 'docs', name: 'docs', kind: 'directory' };
  const leaf: ProjectEntry = { path: 'docs/readme.md', name: 'readme.md', kind: 'file' };
  vi.mocked(listProjectFiles).mockImplementation((_id, path) =>
    Promise.resolve({ entries: path === '' ? [parent] : [leaf], truncated: false }),
  );
  function Folders({ session }: { session: string }) {
    const tree = useDirectories(session, 0);
    return (
      <>
        <button onClick={() => void tree.toggle(parent.path)} />
        <span>
          {treeRows(tree.pages, tree.expanded)
            .map((row) => row.name)
            .join(',')}
        </span>
      </>
    );
  }
  await settle(() => {
    root.render(<Folders key="first" session="first" />);
  });
  await settle(() => {
    host.querySelector('button')?.click();
  });
  expect(host.textContent).toContain('readme.md');
  await settle(() => {
    root.render(<Folders key="second" session="second" />);
  });
  expect(host.textContent).toBe('docs');
  await settle(() => {
    root.render(<Folders key="first" session="first" />);
  });
  expect(host.textContent).toContain('readme.md');
});
