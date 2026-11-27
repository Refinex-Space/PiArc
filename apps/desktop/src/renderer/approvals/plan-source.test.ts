// @vitest-environment happy-dom
// ADR-0103: the plan panel shows the plan rendered, comments stay anchored to UTF-16 offsets of
// the Markdown source. Rendered text maps back to the source block by block.
import { describe, expect, it } from 'vitest';

import { PlanComments } from './plan-comments.js';
import { selectionToSource, sourceToRanges } from './plan-dom.js';
import { alignRendered, lineStarts, linesRange, renderedRuns, sourceRange } from './plan-source.js';

const PLAN =
  '# 计划\n\n1. Read **😀 parser** first\n2. Fix [the loop](https://x.dev/a) in `parse()`';

/** The first and second list items as the renderer shows them (markers by CSS, no markup). */
function render(): HTMLElement {
  const starts = lineStarts(PLAN);
  const root = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = '计划';
  const title = linesRange(PLAN, starts, 1, 1);
  const titleBlock = Object.assign(document.createElement('section'), {});
  titleBlock.setAttribute('data-src-start', String(title.start));
  titleBlock.setAttribute('data-src-end', String(title.end));
  titleBlock.append(heading);
  const list = linesRange(PLAN, starts, 3, 4);
  const listBlock = document.createElement('section');
  listBlock.setAttribute('data-src-start', String(list.start));
  listBlock.setAttribute('data-src-end', String(list.end));
  const ol = document.createElement('ol');
  const first = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = '😀 parser';
  first.append('Read ', strong, ' first');
  const second = document.createElement('li');
  const link = document.createElement('a');
  link.textContent = 'the loop';
  const code = document.createElement('code');
  code.textContent = 'parse()';
  // A copy button the renderer adds is not plan text.
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  second.append('Fix ', link, ' in ', code, copy);
  ol.append(first, second);
  listBlock.append(ol);
  root.append(titleBlock, listBlock);
  document.body.append(root);
  return root;
}

describe('plan source mapping', () => {
  it('finds line starts for LF, CRLF and CR', () => {
    expect(lineStarts('a\nb\r\nc\rd')).toEqual([0, 2, 5, 7]);
    const text = 'one\r\ntwo\nthree';
    expect(linesRange(text, lineStarts(text), 1, 2)).toEqual({ start: 0, end: 8 });
    expect(linesRange(text, lineStarts(text), 3, 3)).toEqual({ start: 9, end: 14 });
  });

  it('matches rendered characters to the source, skipping markup', () => {
    const source = '1. Read **bold** and [link](https://e.x) \\*';
    const rendered = 'Read bold and link *';
    const map = alignRendered(rendered, source, 100);
    // ASCII only: one UTF-16 unit per character.
    const shown = Array.from(map, (at) => source.charAt(at - 100)).join('');
    expect(shown).toBe(rendered);
    expect(sourceRange(map, 5, 9)).toEqual({ start: 110, end: 114 });
    // Text the renderer added maps nowhere and does not widen a range.
    const added = alignRendered('xRead', 'Read');
    expect(added[0]).toBe(-1);
    expect(sourceRange(added, 0, 1)).toBeUndefined();
    expect(renderedRuns(map, 110, 114)).toEqual([{ from: 5, to: 9 }]);
  });

  it('turns a selection across inline markup into the source range it shows', () => {
    const root = render();
    const strong = root.querySelector('strong');
    const code = root.querySelector('code');
    if (strong?.firstChild == null || code?.firstChild == null) throw new Error('not rendered');
    const range = document.createRange();
    range.setStart(strong.firstChild, 3); // after "😀 " (the emoji is two UTF-16 units)
    range.setEnd(code.firstChild, 5); // "parse"
    const found = selectionToSource(root, range, PLAN);
    if (found === undefined) throw new Error('no source range');
    expect(PLAN.slice(found.start, found.end)).toBe(
      'parser** first\n2. Fix [the loop](https://x.dev/a) in `parse',
    );
  });

  it('ignores blocks a selection only touches: a triple click, or a start at a block end', () => {
    const root = render();
    const heading = root.querySelector('h1');
    const firstItem = root.querySelector('li');
    if (heading?.firstChild == null || firstItem?.firstChild == null) throw new Error('none');
    // A triple click on the heading ends at the start of the next block.
    const triple = document.createRange();
    triple.setStart(heading.firstChild, 0);
    triple.setEnd(firstItem.firstChild, 0);
    const title = selectionToSource(root, triple, PLAN);
    if (title === undefined) throw new Error('no source range');
    expect(PLAN.slice(title.start, title.end)).toBe('计划');
    // A selection that starts at the end of the heading selects only the list's text.
    const late = document.createRange();
    late.setStart(heading.firstChild, 2);
    late.setEnd(firstItem.firstChild, 4);
    const read = selectionToSource(root, late, PLAN);
    if (read === undefined) throw new Error('no source range');
    expect(PLAN.slice(read.start, read.end)).toBe('Read');
    // A selection running past the plan's text is clipped to it.
    const outside = document.createElement('p');
    outside.textContent = 'after the plan';
    root.after(outside);
    const past = document.createRange();
    if (outside.firstChild === null) throw new Error('none');
    past.setStart(firstItem.firstChild, 0);
    past.setEnd(outside.firstChild, 5);
    const tail = selectionToSource(root, past, PLAN);
    if (tail === undefined) throw new Error('no source range');
    expect(PLAN.slice(tail.start, tail.end)).toBe(
      PLAN.slice(PLAN.indexOf('Read'), PLAN.indexOf('parse()') + 7),
    );
  });

  it('marks a comment where the rendered text shows it, across elements and blocks', () => {
    const root = render();
    const start = PLAN.indexOf('😀');
    const end = PLAN.indexOf(' first');
    const ranges = sourceToRanges(root, PLAN, start, end);
    expect(ranges.map((r) => r.toString())).toEqual(['😀 parser']);
    const both = sourceToRanges(root, PLAN, PLAN.indexOf('计划'), PLAN.indexOf('Read') + 4);
    expect(both.map((r) => r.toString())).toEqual(['计划', 'Read']);
    // The button's label is not plan text: a range over the code stops at the code.
    const code = PLAN.indexOf('parse()');
    expect(sourceToRanges(root, PLAN, code, code + 7).map((r) => r.toString())).toEqual([
      'parse()',
    ]);
  });

  it('keeps comments ordered, non-overlapping and quoting the plan', () => {
    const comments = new PlanComments();
    const fix = PLAN.indexOf('Fix');
    expect(comments.add('r', PLAN, fix, fix + 3, ' Which bug? ')).toBe(true);
    expect(comments.add('r', PLAN, 0, 4, 'Title')).toBe(true);
    expect(comments.add('r', PLAN, fix + 1, fix + 8, 'overlap')).toBe(false);
    expect(comments.add('r', PLAN, 5, 5, 'empty')).toBe(false);
    expect(comments.add('r', PLAN, 5, 6, '  ')).toBe(false);
    expect(comments.get('r').map((c) => [c.start, c.end, c.quote, c.text])).toEqual([
      [0, 4, '# 计划', 'Title'],
      [fix, fix + 3, 'Fix', 'Which bug?'],
    ]);
    const [first] = comments.get('r');
    if (first === undefined) throw new Error();
    expect(comments.update('r', first.id, ' Shorter title ')).toBe(true);
    expect(comments.get('r')[0]?.text).toBe('Shorter title');
    expect(comments.update('r', first.id, '   ')).toBe(false);
    comments.remove('r', first.id);
    expect(comments.get('r')).toHaveLength(1);
    comments.clear('r');
    expect(comments.get('r')).toEqual([]);
  });
});

describe('question form answers', () => {
  it('needs one answer per question: options, or a free answer', async () => {
    const { formAnswers } = await import('./QuestionForm.js');
    const questions = [
      { question: 'One?', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Many?', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
    ];
    const empty = { selected: [], other: '', otherChosen: false };
    expect(formAnswers(questions, [empty, empty])).toBeUndefined();
    expect(
      formAnswers(questions, [
        { selected: [], other: ' mine ', otherChosen: true },
        { selected: ['X', 'Y'], other: 'ignored', otherChosen: false },
      ]),
    ).toEqual([{ other: 'mine' }, { selected: ['X', 'Y'] }]);
  });
});
