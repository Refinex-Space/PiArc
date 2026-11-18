// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { PageBoundary } from './PageBoundary.js';

function BrokenPage(): never {
  throw new Error('A page could not render');
}

function Window() {
  const [page, setPage] = useState('broken');
  return (
    <>
      <button
        onClick={() => {
          setPage('other');
        }}
      >
        Other session
      </button>
      <PageBoundary key={page} message="Cannot show this page">
        {page === 'broken' ? <BrokenPage /> : <article>Other conversation</article>}
      </PageBoundary>
    </>
  );
}

it('contains a page render failure and recovers when the user navigates', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(<Window />);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Cannot show this page');
    expect(report).toHaveBeenCalled();
    const button = container.querySelector('button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    act(() => button?.click());
    expect(container.querySelector('article')?.textContent).toBe('Other conversation');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    report.mockRestore();
    vi.unstubAllGlobals();
  }
});
