// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { panelsFor, registerPanel, showPanel, usePanels, type PanelContext } from './registry.js';
import { usePanelPresentation, WorkbenchPanels } from './WorkbenchPanels.js';

function ToolSelection({ context }: { context: PanelContext }) {
  const { openIds, closePanel } = usePanelPresentation();
  const available = panelsFor(usePanels(), 'tool', context);
  const visible = openIds.filter((id) => available.some((spec) => spec.id === id));
  return (
    <button
      type="button"
      onClick={() => {
        closePanel('plan');
      }}
    >
      {visible.join(',')}
    </button>
  );
}

it('keeps the selected plan across the gap between approval removal and publication, and restores only the owning session', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const remove = registerPanel({
    id: 'plan',
    title: 'panel.plan',
    order: 1,
    area: 'tool',
    when: (ctx) => ctx.plan === true,
    render: () => null,
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const update = (context: PanelContext) => {
    act(() => {
      root.render(
        <WorkbenchPanels context={context} scope={context.sessionId ?? 'home'}>
          <ToolSelection context={context} />
        </WorkbenchPanels>,
      );
    });
  };
  try {
    const approved = { sessionId: 'first', plan: true };
    const waiting = { sessionId: 'first', plan: false };
    update(approved);
    act(() => {
      showPanel('plan');
    });
    expect(host.textContent).toBe('plan');
    update(waiting);
    expect(host.textContent).toBe('');
    update(approved);
    expect(host.textContent).toBe('plan');
    act(() => {
      host.querySelector('button')?.click();
    });
    update(waiting);
    update(approved);
    expect(host.textContent).toBe('');
    act(() => {
      showPanel('plan');
    });
    update({ sessionId: 'second', plan: true });
    expect(host.textContent).toBe('');
    update(approved);
    expect(host.textContent).toBe('plan');
  } finally {
    act(() => {
      root.unmount();
    });
    remove();
    vi.unstubAllGlobals();
  }
});
