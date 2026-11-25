// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeIpcError } from '../../shared/ipc-error.js';
import { useModelCatalog } from './model-catalog.js';

const CATALOG = JSON.stringify({
  models: [
    {
      provider: 'mock',
      id: 'm',
      name: 'Mock',
      vision: false,
      efforts: ['low'],
      contextWindow: 1000,
      maxOutput: 100,
      toolReliability: 'verified',
      promptCache: false,
    },
  ],
});

/** What the page receives when Core refused (`page-errors.ts`). */
const coreError = (kind: string) =>
  new Error(
    `Error invoking remote method 'piarc:session.models': Error: ${encodeIpcError(kind, 'x')}`,
  );

let seen: { catalog: boolean; failure: string | undefined } = {
  catalog: false,
  failure: undefined,
};

function Probe({ again }: { readonly again: number }) {
  const { catalog, failure } = useModelCatalog('s1', true, again);
  seen = { catalog: catalog !== undefined, failure };
  return null;
}

const sessionModels = vi.fn<(id: string) => Promise<string>>();
let render: (again: number) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => () => undefined, sessionModels });
  const root = createRoot(document.createElement('div'));
  render = (again) => {
    act(() => {
      root.render(<Probe again={again} />);
    });
  };
});

afterEach(() => {
  vi.useRealTimers();
  sessionModels.mockReset();
});

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('the model catalog of a session', () => {
  it('waits out a session still opening in its Agent Host without showing a failure', async () => {
    sessionModels
      .mockRejectedValueOnce(coreError('sessionNotFound'))
      .mockRejectedValueOnce(coreError('sessionNotFound'))
      .mockResolvedValue(CATALOG);
    render(0);
    await settle();
    expect(seen).toEqual({ catalog: false, failure: undefined });
    await settle(250);
    expect(seen.failure).toBeUndefined();
    await settle(500);
    expect(seen).toEqual({ catalog: true, failure: undefined });
    expect(sessionModels).toHaveBeenCalledTimes(3);
  });

  it('shows a lasting failure, and clears it when asked again after the session moved on', async () => {
    sessionModels.mockRejectedValueOnce(coreError('permissionDenied')).mockResolvedValue(CATALOG);
    render(0);
    await settle();
    expect(seen.failure).toBe('Not allowed: x');
    render(1);
    await settle();
    expect(seen).toEqual({ catalog: true, failure: undefined });
  });
});
