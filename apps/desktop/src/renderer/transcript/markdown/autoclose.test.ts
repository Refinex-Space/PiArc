import { describe, expect, it } from 'vitest';

import { closeOpenMarkup, inlineClosers, openFence } from './autoclose.js';

describe('openFence', () => {
  it('finds a fence that is still open', () => {
    expect(openFence('text\n```ts\ncode')).toBe('```');
    expect(openFence('````\ncode\n```')).toBe('````');
    expect(openFence('~~~\ncode')).toBe('~~~');
    expect(openFence('> ```\n> quoted code')).toBe('```');
    expect(openFence('- item\n  ```py\n  code')).toBe('```');
  });

  it('ignores closed fences and lines that are not fences', () => {
    expect(openFence('```\ncode\n```\nafter')).toBeNull();
    expect(openFence('~~~\ncode\n~~~~')).toBeNull();
    expect(openFence('inline ``` is not a fence')).toBeNull();
    expect(openFence('```js `not` a fence')).toBeNull();
  });
});

describe('inlineClosers', () => {
  it.each([
    ['**bold', '**'],
    ['*em', '*'],
    ['_em', '_'],
    ['~~gone', '~~'],
    ['***both', '***'],
    ['**bold and *em', '***'],
    ['`code', '`'],
    ['``code with ` inside', '``'],
    ['**bold `code', '`**'],
    ['[label](https://exam', ')'],
    ['**[label](https://exam', ')**'],
  ])('closes %j with %j', (segment, closers) => {
    expect(inlineClosers(segment)).toBe(closers);
  });

  it.each([
    ['**done** and *done*'],
    ['snake_case_name'],
    ['2 * 3 * 4'],
    ['- list item'],
    ['* list item'],
    ['escaped \\*star'],
    ['`*not emphasis*`'],
    ['ends with an opener **'],
    ['~~~ not strike'],
    ['[label](https://example.com) done'],
  ])('leaves %j alone', (segment) => {
    expect(inlineClosers(segment)).toBe('');
  });
});

describe('closeOpenMarkup', () => {
  it('closes an open fence and nothing inside it', () => {
    expect(closeOpenMarkup('```py\nprint("**")')).toEqual({
      text: '```py\nprint("**")\n```\n',
      openFence: true,
    });
  });

  it('closes inline markup of the last paragraph only, before trailing whitespace', () => {
    expect(closeOpenMarkup('First **open\n\nSecond *open \n')).toEqual({
      text: 'First **open\n\nSecond *open* \n',
      openFence: false,
    });
  });

  it('leaves an indented code block at the end alone', () => {
    expect(closeOpenMarkup('Para\n\n    code **x')).toEqual({
      text: 'Para\n\n    code **x',
      openFence: false,
    });
  });
});
