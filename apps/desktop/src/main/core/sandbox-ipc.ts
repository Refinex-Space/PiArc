// The settings window's sandbox page (T39, architecture section 6.10): the sandbox of a
// workspace and edits to the user's own sandbox values. Turning auto-approval on, adding allowed
// domains, turning the sandbox off and dropping read protections (R5) loosen what commands may
// do, so the main process shows them in a native confirmation before Core saves them
// (architecture section 10.3); the page cannot skip it. Core validates the values and writes only the user's settings file.
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { IPC_CHANNELS, type SandboxChange } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type SandboxCore = Pick<CoreRuntime, 'sandboxSettings' | 'setSandboxSettings'>;

const MAX_ENTRIES = 256;
const MAX_ENTRY = 4096;

function workspace(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) {
    throw new TypeError('workspace must be an absolute path or null');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new TypeError(`${name} must be a list of at most ${String(MAX_ENTRIES)} entries`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > MAX_ENTRY || /[\r\n]/u.test(entry)) {
      throw new TypeError(`${name} entries must be one-line strings`);
    }
    return entry;
  });
}

/** A validated sandbox change: only the known fields, each of its type. */
export function sandboxChange(raw: unknown): SandboxChange {
  if (!isRecord(raw)) throw new TypeError('invalid sandbox change');
  const flag = (value: unknown, name: string): boolean => {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
    return value;
  };
  for (const key of Object.keys(raw)) {
    if (!['enabled', 'autoAllow', 'allowedDomains', 'denyRead'].includes(key)) {
      throw new TypeError(`unknown sandbox setting ${key}`);
    }
  }
  return {
    ...(raw.enabled === undefined ? {} : { enabled: flag(raw.enabled, 'enabled') }),
    ...(raw.autoAllow === undefined ? {} : { autoAllow: flag(raw.autoAllow, 'autoAllow') }),
    ...(raw.allowedDomains === undefined
      ? {}
      : { allowedDomains: entries(raw.allowedDomains, 'allowedDomains') }),
    ...(raw.denyRead === undefined ? {} : { denyRead: entries(raw.denyRead, 'denyRead') }),
  };
}

/** One list of the user's values in a `sandboxSettings` answer. */
function userList(view: string, key: 'allowedDomains' | 'denyRead'): string[] {
  const value: unknown = JSON.parse(view);
  if (!isRecord(value) || !isRecord(value.user)) return [];
  const list = value.user[key];
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [];
}

/** What `change` loosens compared with the user's current values. */
function loosening(view: string, change: SandboxChange) {
  const domains = new Set(userList(view, 'allowedDomains'));
  const kept = new Set((change.denyRead ?? []).map((p) => p.trim()));
  return {
    autoAllow: change.autoAllow === true,
    disable: change.enabled === false,
    added: (change.allowedDomains ?? []).filter((d) => !domains.has(d.trim())),
    unprotected:
      change.denyRead === undefined
        ? []
        : userList(view, 'denyRead').filter((p) => !kept.has(p.trim())),
  };
}

/** Registers the sandbox page's commands. */
export function registerSandboxHandlers(
  registerHandler: RegisterHandler,
  core: SandboxCore,
  translator: () => Translator,
): void {
  registerHandler(IPC_CHANNELS.sandboxSettings, (_event, [dir]) =>
    core.sandboxSettings(workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.sandboxUpdate, async (event, [dir, raw]) => {
    const root = workspace(dir);
    const change = sandboxChange(raw);
    const loose = loosening(await core.sandboxSettings(root), change);
    const reasons = [
      loose.autoAllow,
      loose.disable,
      loose.added.length > 0,
      loose.unprotected.length > 0,
    ];
    if (reasons.some(Boolean)) {
      const t = translator();
      const window = BrowserWindow.fromWebContents(event.sender);
      const message =
        reasons.filter(Boolean).length > 1
          ? 'sandbox.confirmLoosen'
          : loose.autoAllow
            ? 'sandbox.confirmAutoAllow'
            : loose.disable
              ? 'sandbox.confirmDisable'
              : loose.added.length > 0
                ? 'sandbox.confirmDomains'
                : 'sandbox.confirmDenyRead';
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        message: t.t(message),
        detail: [
          ...(loose.autoAllow ? [t.t('sandbox.confirmAutoAllowDetail')] : []),
          ...(loose.disable ? [t.t('sandbox.confirmDisableDetail')] : []),
          ...(loose.added.length > 0
            ? [t.t('sandbox.domains') + '\n' + loose.added.join('\n')]
            : []),
          ...(loose.unprotected.length > 0
            ? [t.t('sandbox.confirmDenyReadDetail') + '\n' + loose.unprotected.join('\n')]
            : []),
        ].join('\n\n'),
        buttons: [t.t('permissions.save'), t.t('dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result =
        window === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(window, options);
      if (result.response !== 0) return JSON.stringify({ status: 'cancelled' });
    }
    return core.setSandboxSettings(root, JSON.stringify(change));
  });
}
