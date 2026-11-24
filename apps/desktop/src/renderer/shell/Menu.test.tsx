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

it('moves into a submenu, returns to its parent, and dismisses the tree after a choice', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selected = vi.fn();
  const key = (value: string) => {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true }),
      );
    });
  };
  try {
    act(() => {
      root.render(
        <MenuButton
          label="Model"
          items={[
            {
              id: 'effort',
              label: 'Effort',
              submenu: [{ id: 'high', label: 'High', run: selected }],
            },
          ]}
        >
          Model
        </MenuButton>,
      );
    });
    const trigger = host.querySelector('button');
    trigger?.focus();
    act(() => {
      trigger?.click();
    });
    key('ArrowRight');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Effort');
    key('Escape');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Model');
    expect(host.querySelectorAll('[role="menu"]')).toHaveLength(1);
    key('ArrowRight');
    key('Enter');
    expect(selected).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('[role="menu"]')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
