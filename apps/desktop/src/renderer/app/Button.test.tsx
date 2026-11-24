// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { Button } from './Button.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('preserves its native form action and label while pending blocks repeated activation', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<HTMLButtonElement>();
  const submit = vi.fn();
  const render = (loading: boolean) => {
    act(() => {
      root.render(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Button
            type="submit"
            ref={ref}
            loading={loading}
            aria-label={loading ? 'Saving' : undefined}
          >
            Save
          </Button>
        </form>,
      );
    });
  };
  try {
    render(false);
    const button = ref.current;
    if (!button) throw new Error('Missing native button');
    const label = button.firstElementChild;
    button.click();
    expect(submit).toHaveBeenCalledTimes(1);
    render(true);
    expect(ref.current).toBe(button);
    expect(button.firstElementChild).toBe(label);
    expect(button.textContent).toBe('Save');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Saving');
    expect(button.disabled).toBe(true);
    button.click();
    expect(submit).toHaveBeenCalledTimes(1);
    render(false);
    expect(button.disabled).toBe(false);
    button.click();
    expect(submit).toHaveBeenCalledTimes(2);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
});
