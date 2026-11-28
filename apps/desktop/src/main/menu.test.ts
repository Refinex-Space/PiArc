import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';

import { Translator } from '../shared/i18n/index.js';
import { effectiveBindings } from '../shared/keybindings.js';
import { buildMenuTemplate } from './menu.js';

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? items(item.submenu) : []),
  ]);
}

describe('buildMenuTemplate', () => {
  it('shows the effective shortcuts and translated labels', () => {
    const ran: string[] = [];
    const template = buildMenuTemplate({
      platform: 'darwin',
      translator: new Translator('zh-CN'),
      bindings: effectiveBindings({ 'session.new': 'Mod+Shift+N' }),
      developer: false,
      run: (command) => ran.push(command),
    });
    const all = items(template);
    const newSession = all.find((item) => item.id === 'session.new');
    expect(newSession?.label).toBe('新建会话');
    expect(newSession?.accelerator).toBe('CommandOrControl+Shift+N');
    expect(all.find((item) => item.id === 'session.next')?.accelerator).toBe('Control+Tab');
    newSession?.click?.(
      ...([] as unknown as Parameters<NonNullable<MenuItemConstructorOptions['click']>>),
    );
    expect(ran).toEqual(['session.new']);
    // Release builds have no developer entries (I11).
    expect(all.some((item) => item.role === 'toggleDevTools' || item.role === 'reload')).toBe(
      false,
    );
    expect(template[0]?.label).toBe('PiArc');
  });

  it('adds developer entries in development builds and drops the app menu off macOS', () => {
    const template = buildMenuTemplate({
      platform: 'win32',
      translator: new Translator('en'),
      bindings: effectiveBindings({ 'help.shortcuts': '' }),
      developer: true,
      run: () => undefined,
    });
    const all = items(template);
    expect(template[0]?.label).toBe('File');
    expect(all.some((item) => item.role === 'toggleDevTools')).toBe(true);
    expect(all.find((item) => item.id === 'help.shortcuts')?.accelerator).toBeUndefined();
  });
});
