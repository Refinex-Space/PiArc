// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

import { createTranscriptServices } from './services.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps the home window free of transcript workers until a transcript needs them', async () => {
  const starts: string[] = [];
  const post = vi.fn();
  vi.stubGlobal(
    'Worker',
    class {
      constructor(_url: URL, options: WorkerOptions) {
        starts.push(options.name ?? '');
      }
      addEventListener = vi.fn();
      postMessage = post;
    },
  );
  const services = createTranscriptServices(null);
  services.driver.reset();
  expect(starts).toEqual([]);

  services.markdown.parseFinished('a', 'A first reply.');
  await Promise.resolve();
  expect(starts).toEqual(['piarc-markdown']);
  expect(post).toHaveBeenCalled();
  services.markdown.parseFinished('b', 'A second reply.');
  expect(starts).toHaveLength(1);
  const highlighter = services.highlight;
  expect(services.highlight).toBe(highlighter);
  expect(starts).toEqual(['piarc-markdown', 'piarc-highlight']);
});
