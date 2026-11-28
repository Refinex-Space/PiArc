import { expect, it } from 'vitest';
import { htmlPresentation } from './viewer-html.js';

it('renders only static document content and gives project links a bounded destination', () => {
  expect(
    htmlPresentation(
      '<head><title>Head</title></head><script>alert(1)</script><h1 style="color:red">Hello &amp; bye</h1><p><a href="../src/file.ts">Open</a><a href="../../outside">No</a></p>',
      'docs/readme.html',
    ),
  ).toEqual([
    { tag: 'h1', children: ['Hello & bye'] },
    {
      tag: 'p',
      children: [
        { tag: 'a', local: 'src/file.ts', children: ['Open'] },
        { tag: 'a', children: ['No'] },
      ],
    },
  ]);
});
it('does not attach event handlers, frames or URLs embedded in a different attribute', () => {
  expect(
    htmlPresentation(
      '<iframe src="https://example.invalid/a">ignore this</iframe><img src="https://example.invalid/b"><a title=" href=https://example.invalid" href="javascript:123" onclick="run()">Click</a>',
      'index.html',
    ),
  ).toEqual([{ tag: 'a', children: ['Click'] }]);
});
