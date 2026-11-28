// @vitest-environment happy-dom
// The question form shows one question at a time: a pager moves between them, a pointer pick on
// a single-select question moves on by itself, and the last page submits every answer.
import type { ApprovalRequest } from '@piarc/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { AUTO_ADVANCE_MS, QuestionForm } from './QuestionForm.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const request: ApprovalRequest = {
  sessionId: 's1',
  requestId: 'r1',
  revision: 1,
  connectionEpoch: 1,
  kind: 'question',
  tool: 'AskUserQuestion',
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres' }],
    },
    {
      question: 'Which platforms?',
      options: [{ label: 'macOS' }, { label: 'Windows' }],
      multiSelect: true,
    },
    { question: 'What name?', options: [{ label: 'PiArc' }] },
  ],
};

let unmount: (() => void) | undefined;
let answers: unknown[];

beforeEach(() => {
  answers = [];
  Object.assign(window, {
    piarc: {
      onAppEvent: () => () => undefined,
      answerApproval: (answer: unknown) => {
        answers.push(answer);
        return Promise.resolve('{"status":"applied"}');
      },
      resendSnapshots: () => Promise.resolve(),
    },
  });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.useRealTimers();
});

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProvider
        initial={{
          platform: 'darwin',
          preferences: { ...DEFAULT_PREFERENCES, language: 'en' },
          locale: 'en',
          focused: true,
          notificationsSupported: true,
        }}
      >
        <QuestionForm request={request} />
      </AppProvider>,
    );
    await Promise.resolve();
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

function shown(card: HTMLElement): string {
  return card.querySelector('[data-testid="question"] .question-text')?.textContent ?? '';
}

function option(card: HTMLElement, label: string): HTMLInputElement {
  const found = Array.from(card.querySelectorAll<HTMLLabelElement>('.question-option')).find(
    (row) => row.textContent.startsWith(label),
  );
  const input = found?.querySelector('input');
  if (!input) throw new Error(`no option ${label}`);
  return input;
}

function button(card: HTMLElement, testId: string): HTMLButtonElement {
  const found = card.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
}

/** A pointer pick: the press on the row, then the click that checks the input. */
function pointerPick(input: HTMLInputElement): void {
  input.closest('label')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  input.click();
}

describe('the question form', () => {
  it('shows one question at a time and pages back and forth', async () => {
    const card = await render();
    expect(card.querySelectorAll('[data-testid="question"]')).toHaveLength(1);
    expect(shown(card)).toBe('Which database?');
    expect(button(card, 'question-position').textContent).toBe('1 / 3');
    expect(button(card, 'question-prev').disabled).toBe(true);
    act(() => {
      button(card, 'question-next-page').click();
    });
    expect(shown(card)).toBe('Which platforms?');
    expect(button(card, 'question-position').textContent).toBe('2 / 3');
    act(() => {
      button(card, 'question-prev').click();
    });
    expect(shown(card)).toBe('Which database?');
  });

  it('moves on by itself after a pointer pick on a single-select question', async () => {
    vi.useFakeTimers();
    const card = await render();
    expect(button(card, 'question-submit').disabled).toBe(true);
    act(() => {
      pointerPick(option(card, 'Postgres'));
    });
    expect(option(card, 'Postgres').checked).toBe(true);
    expect(shown(card)).toBe('Which database?');
    act(() => {
      vi.advanceTimersByTime(AUTO_ADVANCE_MS);
    });
    expect(shown(card)).toBe('Which platforms?');
  });

  it('stays on the page when the choice comes from the keyboard or allows several', async () => {
    vi.useFakeTimers();
    const card = await render();
    act(() => {
      option(card, 'SQLite').click();
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_ADVANCE_MS * 2);
    });
    expect(shown(card)).toBe('Which database?');
    act(() => {
      button(card, 'question-submit').click();
    });
    act(() => {
      pointerPick(option(card, 'macOS'));
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_ADVANCE_MS * 2);
    });
    expect(shown(card)).toBe('Which platforms?');
  });

  it('shows the own-answer field only once Other is chosen', async () => {
    const card = await render();
    expect(card.querySelector('[data-testid="question-other"]')).toBeNull();
    act(() => {
      button(card, 'question-other-choice').click();
    });
    expect(card.querySelector('[data-testid="question-other"]')).not.toBeNull();
  });

  it('sends to an unanswered question before submitting, then submits every answer', async () => {
    const card = await render();
    act(() => {
      option(card, 'SQLite').click();
    });
    act(() => {
      button(card, 'question-next-page').click();
    });
    act(() => {
      button(card, 'question-next-page').click();
    });
    expect(shown(card)).toBe('What name?');
    act(() => {
      option(card, 'PiArc').click();
    });
    expect(button(card, 'question-submit').textContent).toContain('Submit answers');
    act(() => {
      button(card, 'question-submit').click();
    });
    expect(shown(card)).toBe('Which platforms?');
    expect(card.querySelector('[role="alert"]')?.textContent).toBe('Question 2 has no answer yet.');
    expect(answers).toHaveLength(0);
    act(() => {
      option(card, 'Windows').click();
    });
    act(() => {
      button(card, 'question-next-page').click();
    });
    await act(async () => {
      button(card, 'question-submit').click();
      await Promise.resolve();
    });
    expect(answers).toEqual([
      {
        sessionId: 's1',
        requestId: 'r1',
        revision: 1,
        connectionEpoch: 1,
        decision: 'allowOnce',
        answers: [{ selected: ['SQLite'] }, { selected: ['Windows'] }, { selected: ['PiArc'] }],
      },
    ]);
  });
});
