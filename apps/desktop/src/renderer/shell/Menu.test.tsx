// @vitest-environment happy-dom
// R5 (accessibility review A6): closing a popup menu from the keyboard gives the focus back to
// the button that opened it, instead of leaving it on the page body.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { ChoiceButton, MenuButton } from './Menu.js';

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

it('searches into a searchable submenu and lists its matches with the parent in their hint', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const chosen = vi.fn();
  const rows = () =>
    [...host.querySelectorAll('.menu-item')].map((row) =>
      [
        row.querySelector('.menu-item-text')?.textContent,
        row.querySelector('.menu-item-hint')?.textContent,
      ]
        .filter(Boolean)
        .join(' | '),
    );
  const search = (text: string) => {
    const field = host.querySelector('input');
    if (!field) throw new Error('no search field');
    act(() => {
      // React tracks the value it set; the native setter makes the change visible to it.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  try {
    act(() => {
      root.render(
        <ChoiceButton
          label="Model"
          filterLabel="Search models"
          testId="open"
          items={[
            {
              id: 'p-deepseek',
              label: 'DeepSeek',
              searchable: true,
              submenu: [
                { id: 'chat', label: 'deepseek-chat', run: chosen },
                { id: 'r1', label: 'deepseek-reasoner', run: chosen },
              ],
            },
            {
              id: 'p-openai',
              label: 'OpenAI',
              searchable: true,
              submenu: [{ id: 'gpt', label: 'gpt-5', hint: 'GPT-5', run: chosen }],
            },
            {
              id: 'effort',
              label: 'Effort',
              submenu: [{ id: 'high', label: 'High reasoner', run: chosen }],
            },
            { id: 'manage', label: 'Manage providers', run: chosen },
          ]}
        >
          Model
        </ChoiceButton>,
      );
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="open"]')?.click();
    });
    expect(rows()).toEqual(['DeepSeek', 'OpenAI', 'Effort', 'Manage providers']);
    // Models are found inside their provider; a submenu that is not searchable is not.
    search('reason');
    expect(rows()).toEqual(['deepseek-reasoner | DeepSeek']);
    // The provider's name finds its models too.
    search('openai');
    expect(rows()).toEqual(['gpt-5 | OpenAI · GPT-5']);
    search('');
    expect(rows()).toEqual(['DeepSeek', 'OpenAI', 'Effort', 'Manage providers']);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
