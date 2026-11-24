import { useState } from 'react';
import { projectRecord } from '../../shared/project-files.js';
import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { MoreIcon } from '../shell/icons.js';
import { MenuPopup, useMenu, type MenuItem } from '../shell/Menu.js';
import { DEFAULT_VIEWER_SETTINGS, type ViewerSettings } from './viewer-model.js';
import type { ViewerRequest } from './FileViewer.js';

const toggles = [
  'autoSave',
  'tabIndents',
  'wordWrap',
  'indentGuides',
  'showWhitespace',
  'scrollPastEnd',
] as const;
export function useFileSettings() {
  return useState<ViewerSettings>(() => {
    const settings = { ...DEFAULT_VIEWER_SETTINGS };
    let saved: unknown;
    try {
      saved = JSON.parse(localStorage.getItem('piarc.files.preferences') ?? 'null');
    } catch {
      return settings;
    }
    if (!projectRecord(saved)) return settings;
    for (const key of toggles) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    if (typeof saved.tabSize === 'number' && [2, 4, 8].includes(saved.tabSize))
      settings.tabSize = saved.tabSize;
    return settings;
  });
}
export function FileSettings({
  settings,
  change,
  showTree,
  toggleTree,
  previewTabs,
  togglePreview,
  active,
  issue,
  download,
}: {
  settings: ViewerSettings;
  change: (value: ViewerSettings) => void;
  showTree: boolean;
  toggleTree: () => void;
  previewTabs: boolean;
  togglePreview: () => void;
  active: boolean;
  issue: (action: ViewerRequest['action']) => void;
  download: () => void;
}) {
  const t = useT(),
    menu = useMenu();
  const items: MenuItem[] = [
    ...(['find', 'goToLine', 'copy', 'reload'] as const).map((key) => ({
      id: key,
      label: t(`files.${key}`),
      disabled: !active,
      run: () => {
        issue(key);
      },
    })),
    { id: 'download', label: t('files.download'), disabled: !active, run: download },
    { id: 'tree', label: t('files.showTree'), selected: showTree, run: toggleTree },
    { id: 'preview', label: t('files.previewTabs'), selected: previewTabs, run: togglePreview },
    ...toggles.map((key) => ({
      id: key,
      label: t(`files.${key}`),
      selected: settings[key],
      run: () => {
        change({ ...settings, [key]: !settings[key] });
      },
    })),
    {
      id: 'tabSize',
      label: t('files.tabSize'),
      submenu: [2, 4, 8].map((n) => ({
        id: String(n),
        label: String(n),
        selected: settings.tabSize === n,
        run: () => {
          change({ ...settings, tabSize: n });
        },
      })),
    },
  ];
  return (
    <>
      <IconButton
        label={t('files.settings')}
        aria-haspopup="menu"
        aria-expanded={!!menu.open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu.openAt(r.left, r.bottom, e.currentTarget);
        }}
      >
        <MoreIcon dot={0.7} />
      </IconButton>
      {menu.open && (
        <MenuPopup label={t('files.settings')} at={menu.open} items={items} onClose={menu.close} />
      )}
    </>
  );
}
