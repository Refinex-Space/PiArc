// @vitest-environment happy-dom
// R5 (accessibility review A6): closing a popup menu from the keyboard gives the focus back to
// the button that opened it, instead of leaving it on the page body.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { MenuButton } from './Menu.js';

it('gives the focus back to its button when Escape or an item closes it', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ran: string[] = [];
  try {
    act(() => {
      root.render(
        <MenuButton
          label="Actions"
          testId="open"
          items={[{ id: 'pin', label: 'Pin', run: () => ran.push('pin') }]}
        >
          …
        </MenuButton>,
      );
    });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="open"]');
    if (button === null) throw new Error('no button');
    for (const key of ['Escape', 'Enter']) {
      button.focus();
      act(() => {
        button.click();
      });
      const menu = container.querySelector<HTMLElement>('[role="menu"]');
      expect(document.activeElement).toBe(menu);
      act(() => {
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button);
    }
    expect(ran).toEqual(['pin']);
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
