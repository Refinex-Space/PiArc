// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readProjectFile, saveProjectFile, type ProjectFile } from './api.js';
import { discardViewerDraft, useFileDocument } from './viewer-document.js';

vi.mock('./api.js', () => ({ readProjectFile: vi.fn(), saveProjectFile: vi.fn() }));
const path = 'docs/sample.md';
function disk(text: string, revision: string): ProjectFile {
  return { kind: 'text', editable: true, size: text.length, path, text, revision };
}
let root: Root;
let view: ReturnType<typeof useFileDocument>;
function Probe({ id = 's' }: { id?: string }) {
  view = useFileDocument(id, path, true, 0, false);
  return <span>{view.draft}</span>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  discardViewerDraft('s', path);
  discardViewerDraft('other', path);
  vi.unstubAllGlobals();
});
it('retains edits after a disk conflict, offers the exact new revision and never overwrites implicitly', async () => {
  vi.mocked(readProjectFile)
    .mockResolvedValueOnce(disk('base', 'a'))
    .mockResolvedValueOnce(disk('other', 'b'));
  vi.mocked(saveProjectFile)
    .mockRejectedValueOnce(new Error('changed'))
    .mockResolvedValueOnce({ size: 4, revision: 'c' });
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  act(() => {
    view.setDraft('mine');
  });
  await act(async () => {
    await view.save();
  });
  expect(view.draft).toBe('mine');
  expect(view.conflict?.text).toBe('other');
  expect(saveProjectFile).toHaveBeenCalledTimes(1);
  expect(saveProjectFile).toHaveBeenNthCalledWith(1, 's', path, 'mine', 'a');
  await act(async () => {
    await view.save(view.conflict);
  });
  expect(saveProjectFile).toHaveBeenNthCalledWith(2, 's', path, 'mine', 'b');
  expect(view.dirty).toBe(false);
});
it('keeps newer keystrokes and its save identity across unmount and isolates drafts by parent session', async () => {
  vi.mocked(readProjectFile).mockResolvedValue(disk('base', 'a'));
  let resolve: (v: { size: number; revision: string }) => void = () => {
    throw new Error('Save was not started');
  };
  vi.mocked(saveProjectFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  act(() => {
    view.setDraft('first');
  });
  act(() => {
    void view.save();
  });
  act(() => {
    view.setDraft('second');
  });
  await act(async () => {
    root.render(<Probe key="other" id="other" />);
    await Promise.resolve();
  });
  expect(view.draft).toBe('base');
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
  await act(async () => {
    resolve({ size: 5, revision: 'b' });
    await Promise.resolve();
  });
  await act(async () => {
    root.render(<Probe key="s" />);
    await Promise.resolve();
  });
  expect(view.draft).toBe('second');
  expect(view.file?.revision).toBe('b');
  expect(view.dirty).toBe(true);
  act(() => {
    root.render(null);
  });
  discardViewerDraft('s', path);
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  expect(view.draft).toBe('base');
});
