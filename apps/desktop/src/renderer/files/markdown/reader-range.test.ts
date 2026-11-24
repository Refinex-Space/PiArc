// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { readerRange } from './reader-range.js';
it('locates a partial rendered quotation in a multiline source paragraph and uses the selected occurrence', () => {
  const reader = document.createElement('div'),
    section = reader.appendChild(document.createElement('section'));
  reader.className = 'markdown-reader';
  section.dataset.docLine = '3';
  section.dataset.endLine = '5';
  const p = section.appendChild(document.createElement('p')),
    node = p.appendChild(
      document.createTextNode('One shared word\nTwo shared words\nEnd of paragraph'),
    );
  const range = document.createRange(),
    start = node.textContent.indexOf('shared', 4 + 7);
  range.setStart(node, start);
  range.setEnd(node, start + 6);
  expect(
    readerRange(range, ['# Head', '', 'One shared word', 'Two shared words', 'End of paragraph']),
  ).toEqual({ text: 'shared', startLine: 4, endLine: 4 });
});
