// The menu-bar icon (macOS) and tray icon (Windows) that keep PiArc reachable with no window
// open (T35, architecture sections 3.3 and 8.8): how many sessions run and how many wait for an
// approval, and a menu to open a window, jump to a waiting session, or quit.
//
// The counts are Core's: its snapshot task sends them on the route `core/activity` (taken from
// the session list it sends to the windows), and this module only shows the last one. It does
// not count anything itself.
import path from 'node:path';

import {
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import type { Translator } from '../../shared/i18n/index.js';

/** One session the menu lists. */
export interface ActivitySession {
  readonly id: string;
  readonly title?: string;
  readonly workspace?: string;
}

/** Core's `core/activity` payload. */
export interface Activity {
  readonly running: number;
  readonly awaiting: number;
  readonly awaitingSessions: readonly ActivitySession[];
}

export const IDLE: Activity = { running: 0, awaiting: 0, awaitingSessions: [] };

/** Longest title a menu item shows. */
const TITLE_CHARS = 60;

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The last activity in a `core/activity` batch (a UTF-8 JSON array of events). */
export function parseActivity(payload: Uint8Array): Activity | undefined {
  let events: unknown;
  try {
    events = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  const last: unknown = events.at(-1);
  if (typeof last !== 'object' || last === null) return undefined;
  const value = last as Record<string, unknown>;
  const running = count(value.running);
  const awaiting = count(value.awaiting);
  if (running === undefined || awaiting === undefined) return undefined;
  const sessions = Array.isArray(value.awaitingSessions) ? value.awaitingSessions : [];
  return {
    running,
    awaiting,
    awaitingSessions: sessions.flatMap((item: unknown): ActivitySession[] => {
      if (typeof item !== 'object' || item === null) return [];
      const s = item as Record<string, unknown>;
      if (typeof s.id !== 'string') return [];
      return [
        {
          id: s.id,
          ...(typeof s.title === 'string' ? { title: s.title } : {}),
          ...(typeof s.workspace === 'string' ? { workspace: s.workspace } : {}),
        },
      ];
    }),
  };
}

/** The text next to the macOS menu-bar icon: `▸2 ?1`, nothing when both are zero. */
export function trayTitle(activity: Activity): string {
  return [
    activity.running > 0 ? `▸${String(activity.running)}` : '',
    activity.awaiting > 0 ? `?${String(activity.awaiting)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function trayTooltip(activity: Activity, t: Translator): string {
  return t.t('tray.tooltip', {
    running: String(activity.running),
    awaiting: String(activity.awaiting),
  });
}

function short(text: string): string {
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text;
}

/** What the menu's items do. */
export interface TrayActions {
  readonly open: () => void;
  readonly newWindow: () => void;
  readonly openSession: (id: string) => void;
  readonly quit: () => void;
}

/** The tray menu: open, waiting sessions, quit. */
export function trayMenuTemplate(
  activity: Activity,
  t: Translator,
  actions: TrayActions,
  untitled: string,
): MenuItemConstructorOptions[] {
  const waiting: MenuItemConstructorOptions[] =
    activity.awaitingSessions.length === 0
      ? [{ id: 'tray.noneAwaiting', label: t.t('tray.noneAwaiting'), enabled: false }]
      : activity.awaitingSessions.map((session) => ({
          id: `tray.session.${session.id}`,
          label: short(session.title ?? untitled),
          ...(session.workspace === undefined
            ? {}
            : { sublabel: path.basename(session.workspace) }),
          click: () => {
            actions.openSession(session.id);
          },
        }));
  return [
    { id: 'tray.open', label: t.t('tray.open'), click: actions.open },
    { id: 'tray.newWindow', label: t.t('tray.newWindow'), click: actions.newWindow },
    { type: 'separator' },
    { id: 'tray.awaiting', label: t.t('tray.awaiting'), enabled: false },
    ...waiting,
    { type: 'separator' },
    { id: 'tray.quit', label: t.t('tray.quit'), click: actions.quit },
  ];
}

/** Where the icons are: the packaged app's resources, else the repository's design/brand/. */
export function trayIconDirectory(packaged: boolean, resources: string, appPath: string): string {
  return packaged ? resources : path.join(appPath, '..', '..', 'design', 'brand');
}

/** What tests read back (`__piarcTestHooks.tray`). */
export interface TrayObservation {
  readonly title: string;
  readonly tooltip: string;
  readonly items: readonly string[];
  readonly activity: Activity;
}

/** The tray icon of the running app. */
export class TrayIcon {
  readonly #tray: Tray;
  #activity: Activity = IDLE;
  #items: string[] = [];

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly iconDirectory: string,
    private readonly translator: () => Translator,
    private readonly actions: TrayActions,
  ) {
    this.#tray = new Tray(this.#image());
    if (platform === 'win32') {
      // A click on the Windows tray icon opens a window; the menu is on the right button.
      this.#tray.on('click', actions.open);
      nativeTheme.on('updated', () => {
        this.#tray.setImage(this.#image());
      });
    }
    this.update(IDLE);
  }

  #image(): NativeImage {
    if (this.platform === 'darwin') {
      const image = nativeImage.createFromPath(path.join(this.iconDirectory, 'trayTemplate.png'));
      image.setTemplateImage(true);
      return image;
    }
    // A white glyph on the default dark taskbar, a black one on a light taskbar.
    const name = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
      ? 'tray-dark.ico'
      : 'tray-light.ico';
    return nativeImage.createFromPath(path.join(this.iconDirectory, name));
  }

  /** Shows `activity` (Core's latest counts). */
  update(activity: Activity): void {
    this.#activity = activity;
    const t = this.translator();
    if (this.platform === 'darwin') this.#tray.setTitle(trayTitle(activity));
    this.#tray.setToolTip(trayTooltip(activity, t));
    const template = trayMenuTemplate(activity, t, this.actions, t.t('session.untitled'));
    this.#items = template.flatMap((item) => (item.id === undefined ? [] : [item.id]));
    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /** The language changed: rebuild the texts. */
  refresh(): void {
    this.update(this.#activity);
  }

  observe(): TrayObservation {
    return {
      title: this.#tray.getTitle(),
      tooltip: trayTooltip(this.#activity, this.translator()),
      items: [...this.#items],
      activity: this.#activity,
    };
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
