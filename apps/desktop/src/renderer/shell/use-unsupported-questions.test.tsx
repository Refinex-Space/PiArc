// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { useUnsupportedQuestions } from './use-unsupported-questions.js';

const fixture = vi.hoisted(() => ({
  answer: vi.fn().mockResolvedValue(JSON.stringify({ status: 'applied' })),
  toast: vi.fn(),
  session: {
    id: 'other',
    approvals: [
      { kind: 'question', sessionId: 'other', requestId: 'q', revision: 1, connectionEpoch: 7 },
    ],
  },
}));
vi.mock('../store/hooks.js', () => ({ useSessions: () => [fixture.session] }));
vi.mock('./ui.js', () => ({ useUi: () => ({ addToast: fixture.toast }) }));
vi.mock('../app/app-context.js', () => ({ useT: () => () => 'Question forms are unsupported.' }));

it('declines unsupported questions once per revision even for sessions not currently displayed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, { piarc: { answerApproval: fixture.answer } });
  function Connected() {
    useUnsupportedQuestions();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <Connected />
        </StrictMode>,
      );
      await Promise.resolve();
    });
    expect(fixture.answer).toHaveBeenCalledTimes(1);
    expect(fixture.answer).toHaveBeenCalledWith({
      sessionId: 'other',
      requestId: 'q',
      revision: 1,
      connectionEpoch: 7,
      decision: 'deny',
      feedback: 'Question forms are unsupported.',
    });
    expect(fixture.toast).toHaveBeenCalledWith({
      sessionId: 'other',
      text: 'Question forms are unsupported.',
    });
  } finally {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});
