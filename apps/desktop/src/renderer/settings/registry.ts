// Settings pages (architecture section 8.2: the settings window's navigation is built from what
// tasks register). T18 registers General, Appearance and Keyboard Shortcuts
// (`settings/pages.tsx`); later tasks add theirs (models and providers T21, permissions T20/T23,
// hooks T25, MCP T36, ...) with `registerSettingsPage`.
import type { ComponentType } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';

/** The navigation's groups, in order (ADR-0101). */
export const SETTINGS_GROUPS = [
  'app',
  'models',
  'security',
  'agents',
  'tools',
  'data',
  'support',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsPage {
  /** Stable id: the window's hash route `#/settings/<id>` opens it. */
  readonly id: string;
  /** Message id of the navigation label and page title. */
  readonly title: MessageId;
  /** Message id of the one line under the page title. */
  readonly description: MessageId;
  /** The navigation group the page is listed in. */
  readonly group: SettingsGroup;
  /** Whether the page's settings are chosen per project (marked in the navigation). */
  readonly scoped?: boolean;
  /** Lower first within its group. */
  readonly order: number;
  readonly component: ComponentType;
}

const pages = new Map<string, SettingsPage>();

/** Adds a page (replacing one with the same id). */
export function registerSettingsPage(page: SettingsPage): void {
  pages.set(page.id, page);
}

/** The registered pages in navigation order: by group, then by `order`. */
export function settingsPages(): readonly SettingsPage[] {
  return [...pages.values()].sort(
    (a, b) =>
      SETTINGS_GROUPS.indexOf(a.group) - SETTINGS_GROUPS.indexOf(b.group) || a.order - b.order,
  );
}
