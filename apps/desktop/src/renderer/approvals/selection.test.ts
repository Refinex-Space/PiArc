// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { PlanComments } from './plan-comments.js';
import { selectionRange } from './selection.js';

const PLAN = '# 计划\n\n1. Read 😀 parser\n2. Fix it';

function render(): HTMLElement {
  const container = document.createElement('div');
  // "Read 😀" is marked (an earlier comment): the text is split across three nodes.
  const at = PLAN.indexOf('Read 😀');
  container.append(
    document.createTextNode(PLAN.slice(0, at)),
    Object.assign(document.createElement('mark'), { textContent: 'Read 😀' }),
    document.createTextNode(PLAN.slice(at + 'Read 😀'.length)),
  );
  document.body.append(container);
  return container;
}

describe('plan selections', () => {
  it('measures selections in UTF-16 units across text nodes and marks', () => {
    const container = render();
    const [head, mark, tail] = [...container.childNodes];
    if (head === undefined || mark?.firstChild == null || tail === undefined) throw new Error();
    const range = document.createRange();
    range.setStart(mark.firstChild, 5); // after "Read "
    range.setEnd(tail, ' parser'.length);
    const found = selectionRange(container, range);
    expect(found).toEqual({
      start: PLAN.indexOf('😀'),
      end: PLAN.indexOf(' parser') + ' parser'.length,
    });
    if (found === undefined) throw new Error();
    expect(PLAN.slice(found.start, found.end)).toBe('😀 parser');
    expect(selectionRange(container, document.createRange())).toBeUndefined();
  });

  it('keeps comments ordered, non-overlapping and quoting the plan', () => {
    const comments = new PlanComments();
    const fix = PLAN.indexOf('Fix it');
    expect(comments.add('r', PLAN, fix, fix + 6, ' Which bug? ')).toBe(true);
    expect(comments.add('r', PLAN, 0, 4, 'Title')).toBe(true);
    expect(comments.add('r', PLAN, fix + 2, fix + 8, 'overlap')).toBe(false);
    expect(comments.add('r', PLAN, 5, 5, 'empty')).toBe(false);
    expect(comments.add('r', PLAN, 5, 6, '  ')).toBe(false);
    expect(comments.get('r').map((c) => [c.start, c.end, c.quote, c.text])).toEqual([
      [0, 4, '# 计划', 'Title'],
      [fix, fix + 6, 'Fix it', 'Which bug?'],
    ]);
    const [first] = comments.get('r');
    if (first === undefined) throw new Error();
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
