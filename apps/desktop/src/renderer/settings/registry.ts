// Settings pages (architecture section 8.2: the settings window's navigation is built from what
// tasks register). T18 registers General, Appearance and Keyboard Shortcuts
// (`settings/pages.tsx`); later tasks add theirs (models and providers T21, permissions T20/T23,
// hooks T25, MCP T36, ...) with `registerSettingsPage`.
import type { ComponentType } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';

export interface SettingsPage {
  /** Stable id: the window's hash route `#/settings/<id>` opens it. */
  readonly id: string;
  /** Message id of the navigation label and page title. */
  readonly title: MessageId;
  /** Lower first. */
  readonly order: number;
  readonly component: ComponentType;
}

const pages = new Map<string, SettingsPage>();

/** Adds a page (replacing one with the same id). */
export function registerSettingsPage(page: SettingsPage): void {
  pages.set(page.id, page);
}

/** The registered pages in navigation order. */
export function settingsPages(): readonly SettingsPage[] {
  return [...pages.values()].sort((a, b) => a.order - b.order);
}
