import { beforeEach, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { markdownPaste } from './markdown-paste.js';

const evaluate = vi.fn<() => Promise<unknown>>(),
  paste = vi.fn();
const frame = {};
const fake = {
  mainFrame: frame,
  focusedFrame: frame,
  executeJavaScriptInIsolatedWorld: evaluate,
  paste,
  isDestroyed: () => false,
};
const sender = fake as unknown as WebContents;
beforeEach(() => {
  vi.clearAllMocks();
});
it('delivers a native paste only after the owned foreground editor consumed a genuine menu gesture', async () => {
  evaluate.mockResolvedValueOnce(true);
  await markdownPaste(
    'pasteMarkdown',
    'session',
    'file.md',
    sender,
    () => sender,
    () => undefined,
  );
  expect(evaluate).toHaveBeenCalledOnce();
  expect(paste).toHaveBeenCalledOnce();
  for (const value of [false, null, 'true']) {
    evaluate.mockResolvedValueOnce(value);
    await expect(
      markdownPaste(
        'pasteMarkdown',
        'session',
        'file.md',
        sender,
        () => sender,
        () => undefined,
      ),
    ).rejects.toThrow();
  }
  expect(paste).toHaveBeenCalledOnce();
});
it('rejects an unowned window, a web document frame, and a window focus change during validation', async () => {
  const outsider = { ...fake } as unknown as WebContents;
  for (const target of [
    undefined,
    outsider,
    { ...fake, focusedFrame: {} } as unknown as WebContents,
  ]) {
    await expect(
      markdownPaste(
        'pasteMarkdown',
        'session',
        'file.md',
        sender,
        () => target,
        (w) => (w === outsider ? undefined : sender),
      ),
    ).rejects.toThrow();
  }
  evaluate.mockResolvedValueOnce(true);
  let reads = 0;
  await expect(
    markdownPaste(
      'pasteMarkdown',
      'session',
      'file.md',
      sender,
      () => (++reads === 1 ? sender : undefined),
      () => undefined,
    ),
  ).rejects.toThrow();
  expect(paste).not.toHaveBeenCalled();
});
