// The application menu (replaces Electron's default menu, I11): labels from the shared catalog,
// accelerators from the keyboard shortcut registry with the user's overrides. Rebuilt whenever
// the language or a shortcut changes, so the menu always shows the keys that work.
//
// Developer entries (reload, developer tools) exist only in development builds; release builds
// have none (I11).
import type { MenuItemConstructorOptions } from 'electron';

import type { AppCommand } from '../shared/ipc.js';

/** Commands the main process runs itself (T35): quitting asks first when work is running. */
export type MainCommand = 'app.quit' | 'window.new';
import type { Translator } from '../shared/i18n/index.js';
import { commandLabel, toAccelerator, type CommandId } from '../shared/keybindings.js';

export interface MenuContext {
  readonly platform: string;
  readonly translator: Translator;
  /** Effective key of every command (`''` = unbound). */
  readonly bindings: Readonly<Record<CommandId, string>>;
  /** Development build: reload and developer tools entries. */
  readonly developer: boolean;
  /** Runs a command (the main process forwards most of them to the focused main window). */
  readonly run: (command: AppCommand | MainCommand) => void;
}

/** The menu template for `context`. */
export function buildMenuTemplate(context: MenuContext): MenuItemConstructorOptions[] {
  const { translator, bindings, run } = context;
  const t = translator.t.bind(translator);
  const mac = context.platform === 'darwin';
  const command = (id: CommandId): MenuItemConstructorOptions => {
    const accelerator = toAccelerator(bindings[id]);
    return {
      id,
      label: t(commandLabel(id)),
      ...(accelerator === undefined ? {} : { accelerator }),
      click: () => {
        run(id);
      },
    };
  };
  const separator: MenuItemConstructorOptions = { type: 'separator' };

  const appMenu: MenuItemConstructorOptions = {
    label: t('app.name'),
    submenu: [
      { role: 'about', label: t('menu.app.about') },
      separator,
      command('app.settings'),
      separator,
      { role: 'services', label: t('menu.app.services') },
      separator,
      { role: 'hide', label: t('menu.app.hide') },
      { role: 'hideOthers', label: t('menu.app.hideOthers') },
      { role: 'unhide', label: t('menu.app.showAll') },
      separator,
      {
        id: 'app.quit',
        label: t('menu.app.quit'),
        accelerator: 'Command+Q',
        click: () => {
          run('app.quit');
        },
      },
    ],
  };
  const fileMenu: MenuItemConstructorOptions = {
    label: t('menu.file'),
    submenu: [
      command('session.new'),
      {
        id: 'window.new',
        label: t('tray.newWindow'),
        click: () => {
          run('window.new');
        },
      },
      {
        id: 'workspace.openFolder',
        label: t('menu.file.openFolder'),
        click: () => {
          run('workspace.openFolder');
        },
      },
      separator,
      command('session.close'),
      ...(mac
        ? []
        : [
            separator,
            command('app.settings'),
            separator,
            {
              id: 'app.quit',
              label: t('menu.file.exit'),
              click: () => {
                run('app.quit');
              },
            },
          ]),
    ],
  };
  const editMenu: MenuItemConstructorOptions = {
    label: t('menu.edit'),
    submenu: [
      { role: 'undo', label: t('menu.edit.undo') },
      { role: 'redo', label: t('menu.edit.redo') },
      separator,
      { role: 'cut', label: t('menu.edit.cut') },
      { role: 'copy', label: t('menu.edit.copy') },
      { role: 'paste', label: t('menu.edit.paste') },
      { role: 'selectAll', label: t('menu.edit.selectAll') },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: t('menu.view'),
    submenu: [
      {
        id: 'view.toggleSidebar',
        label: t('menu.view.toggleSidebar'),
        click: () => {
          run('view.toggleSidebar');
        },
      },
      command('terminal.toggle'),
      separator,
      ...(context.developer
        ? [
            { role: 'reload' as const, label: t('menu.view.reload') },
            { role: 'toggleDevTools' as const, label: t('menu.view.toggleDevTools') },
            separator,
          ]
        : []),
      { role: 'resetZoom', label: t('menu.view.actualSize') },
      { role: 'zoomIn', label: t('menu.view.zoomIn') },
      { role: 'zoomOut', label: t('menu.view.zoomOut') },
      separator,
      { role: 'togglefullscreen', label: t('menu.view.fullScreen') },
    ],
  };
  const windowMenu: MenuItemConstructorOptions = {
    label: t('menu.window'),
    submenu: [
      command('session.next'),
      command('session.model'),
      command('session.effort'),
      separator,
      { role: 'minimize', label: t('menu.window.minimize') },
      ...(mac
        ? [
            { role: 'zoom' as const, label: t('menu.window.zoom') },
            separator,
            { role: 'front' as const, label: t('menu.window.front') },
          ]
        : []),
    ],
  };
  const helpMenu: MenuItemConstructorOptions = {
    label: t('menu.help'),
    role: 'help',
    submenu: [command('help.shortcuts')],
  };
  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
