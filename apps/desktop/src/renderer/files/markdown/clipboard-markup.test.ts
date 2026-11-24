// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { selectionMarkup, markdownToHtml } from './clipboard-markup.js';
it('exports a partial rendered selection with its Markdown marks and only semantic HTML', () => {
  const container = document.createElement('article'),
    p = container.appendChild(document.createElement('p')),
    strong = p.appendChild(document.createElement('strong'));
  strong.className = 'private-layout';
  const text = strong.appendChild(document.createTextNode('hello world'));
  const sel = document.createRange();
  sel.setStart(text, 6);
  sel.setEnd(text, 11);
  expect(selectionMarkup(sel, 'markdown')).toBe('**world**');
  expect(selectionMarkup(sel, 'html')).toBe('<p><strong>world</strong></p>');
});
it('quotes raw markup when exporting source selections as HTML code', () => {
  const result = markdownToHtml('**okay** <script>example()</script>');
  expect(result).toContain('<strong>okay</strong>');
  expect(result).not.toContain('<script>');
  expect(result).toContain('&lt;script&gt;');
});
