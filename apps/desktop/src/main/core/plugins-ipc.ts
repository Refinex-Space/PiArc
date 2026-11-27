// The settings window's extension packages (T40, architecture sections 6.7 and 10.1): listing,
// installing, updating, turning on and off, confirming and uninstalling Claude Code plugins and
// Pi packages. Turning a package on, and allowing items an update added, run code (hooks, MCP
// servers, Pi extensions inside the Agent Host): the main process shows the source and every
// executable item in a native confirmation first, and only the items it showed are confirmed
// to Core. The page cannot skip it. Playwright cannot click native dialogs: development builds'
// test hooks answer the next confirmation through `NativeConfirm` (release builds load a Core
// without testing exports, so the hooks, and with them the answers, never exist there).
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { IPC_CHANNELS, type PackageInstallInput } from '../../shared/ipc.js';
import type { MessageId, Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type PackagesCore = Pick<
  CoreRuntime,
  | 'packagesList'
  | 'packageInstall'
  | 'packageUpdate'
  | 'packageSetEnabled'
  | 'packageConfirm'
  | 'packageUninstall'
>;

/** One native confirmation as shown (test hooks read them). */
export interface ShownConfirmation {
  readonly message: string;
  readonly detail: string;
}

/**
 * Asks the user in a native dialog. Answers planned by a test (development builds only) take
 * the dialog's place, one per confirmation; every confirmation is recorded while testing.
 */
export class NativeConfirm {
  readonly #answers: boolean[] = [];
  readonly #shown: ShownConfirmation[] = [];
  #testing = false;

  /** Development builds' test hooks: the next confirmation answers `answer`. */
  answerNext(answer: boolean): void {
    this.#testing = true;
    this.#answers.push(answer);
  }

  /** The confirmations shown since the test hooks started answering. */
  shown(): readonly ShownConfirmation[] {
    return [...this.#shown];
  }

  async ask(
    window: BrowserWindow | null,
    text: ShownConfirmation,
    buttons: readonly [string, string],
  ): Promise<boolean> {
    if (this.#testing) this.#shown.push(text);
    const planned = this.#answers.shift();
    if (planned !== undefined) return planned;
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: text.message,
      detail: text.detail,
      buttons: [...buttons],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const result =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    return result.response === 0;
  }
}

const MAX_LOCATION = 4096;
const MAX_ID = 256;

/** Whether `text` has a control character (C0 or DEL). */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function workspace(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > MAX_LOCATION) {
    throw new TypeError('workspace must be an absolute path or null');
  }
  return value;
}

function packageId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID || hasControl(value)) {
    throw new TypeError('id must be a package id');
  }
  return value;
}

function scope(value: unknown): 'user' | 'project' {
  if (value !== 'user' && value !== 'project') throw new TypeError('scope must be user or project');
  return value;
}

/** A validated install request. */
export function installInput(raw: unknown): PackageInstallInput {
  if (!isRecord(raw)) throw new TypeError('invalid package install request');
  const kind = raw.kind;
  if (kind !== 'directory' && kind !== 'git' && kind !== 'npm') {
    throw new TypeError('kind must be directory, git or npm');
  }
  const location = raw.location;
  if (
    typeof location !== 'string' ||
    location.trim() === '' ||
    location.length > MAX_LOCATION ||
    hasControl(location)
  ) {
    throw new TypeError('location must be one line');
  }
  if (kind === 'directory' && !path.isAbsolute(location)) {
    throw new TypeError('a directory must be an absolute path');
  }
  const where = scope(raw.scope);
  const dir = raw.workspace === undefined ? null : workspace(raw.workspace);
  if (where === 'project' && dir === null)
    throw new TypeError('the project scope needs a workspace');
  return {
    kind,
    location: location.trim(),
    scope: where,
    ...(dir === null ? {} : { workspace: dir }),
  };
}

/** The members of a listed package the confirmation shows. */
export interface ListedPackage {
  readonly id: string;
  /** `claudePlugin` or `piPackage`. */
  readonly kind?: string;
  /** Components PiArc does not support. */
  readonly unsupported?: readonly string[];
  readonly source: {
    readonly kind: string;
    readonly location: string;
    readonly commit?: string;
    readonly version?: string;
    readonly integrity?: string;
    /** The npm package name (npm sources). */
    readonly npmName?: string;
    /** Install scripts the package declares (never run). */
    readonly installScripts?: readonly string[];
  };
  readonly components: Readonly<Record<string, readonly string[]>>;
  readonly executables: readonly {
    readonly kind: string;
    readonly name: string;
    readonly confirmed: boolean;
  }[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Package `id` of a `PackagesList` answer. */
export function listedPackage(list: string, id: string): ListedPackage | undefined {
  const value: unknown = JSON.parse(list);
  if (!isRecord(value) || !Array.isArray(value.packages)) return undefined;
  const raw: unknown = value.packages.find((p: unknown) => isRecord(p) && p.id === id);
  if (!isRecord(raw) || !isRecord(raw.source)) return undefined;
  const source = raw.source;
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const components = isRecord(raw.components)
    ? Object.fromEntries(Object.entries(raw.components).map(([k, v]) => [k, strings(v)]))
    : {};
  const executables = (Array.isArray(raw.executables) ? raw.executables : []).flatMap(
    (e: unknown) =>
      isRecord(e) && typeof e.kind === 'string' && typeof e.name === 'string'
        ? [{ kind: e.kind, name: e.name, confirmed: e.confirmed === true }]
        : [],
  );
  const commit = text(source.commit);
  const version = text(source.version);
  const integrity = text(source.integrity);
  const npmName = text(source.npmName);
  const kind = text(raw.kind);
  return {
    id,
    ...(kind === undefined ? {} : { kind }),
    unsupported: strings(raw.unsupported),
    source: {
      kind: text(source.kind) ?? '',
      location: text(source.location) ?? '',
      ...(commit === undefined ? {} : { commit }),
      ...(version === undefined ? {} : { version }),
      ...(integrity === undefined ? {} : { integrity }),
      ...(npmName === undefined ? {} : { npmName }),
      installScripts: strings(source.installScripts),
    },
    components,
    executables,
  };
}

const KINDS = ['hook', 'mcpServer', 'piExtension', 'agentHook', 'agentMcpServer'] as const;

/** The registry host of a market package's location (`https://<host>/<name>`). */
function registryHost(pkg: ListedPackage): string | undefined {
  if (pkg.source.kind !== 'npm' || !pkg.source.location.startsWith('https://')) return undefined;
  try {
    return new URL(pkg.source.location).host;
  } catch {
    return undefined;
  }
}

/**
 * The text of a confirmation: what the package is (type; npm name and id, with a warning when
 * they differ; registry host), its source (location; git commit; npm version and integrity),
 * declared install scripts that never run, unsupported parts, the scope turned on, each
 * executable item of `items` by kind with the note that Pi extensions run in the Agent Host, or,
 * without executable items, the components (ADR-0102, M-18).
 */
export function confirmationText(
  t: Translator,
  pkg: ListedPackage,
  items: readonly { readonly kind: string; readonly name: string }[],
  message: MessageId,
  scope?: 'user' | 'project',
): ShownConfirmation {
  const sourceKind: MessageId =
    pkg.source.kind === 'git'
      ? 'plugins.source.git'
      : pkg.source.kind === 'npm'
        ? 'plugins.source.npm'
        : 'plugins.source.directory';
  const source = [
    `${t.t(sourceKind)}: ${pkg.source.location}`,
    ...(pkg.source.commit === undefined
      ? []
      : [t.t('plugins.commit', { commit: pkg.source.commit })]),
    ...(pkg.source.version === undefined
      ? []
      : [t.t('plugins.version', { version: pkg.source.version })]),
    ...(pkg.source.integrity === undefined
      ? []
      : [t.t('plugins.integrity', { integrity: pkg.source.integrity })]),
  ].join('\n');
  const about: string[] = [];
  if (pkg.kind === 'claudePlugin' || pkg.kind === 'piPackage') {
    about.push(
      t.t(pkg.kind === 'piPackage' ? 'plugins.type.piPackage' : 'plugins.type.claudePlugin'),
    );
  }
  const npmName = pkg.source.npmName;
  if (npmName !== undefined) {
    about.push(
      npmName === pkg.id
        ? t.t('plugins.confirm.npmName', { name: npmName })
        : t.t('plugins.confirm.nameDiffers', { name: npmName, id: pkg.id }),
    );
  }
  const host = registryHost(pkg);
  if (host !== undefined) about.push(t.t('plugins.confirm.registry', { host }));
  if (scope !== undefined) {
    about.push(t.t(scope === 'project' ? 'plugins.scope.project' : 'plugins.scope.user'));
  }
  const notes: string[] = [];
  const scripts = pkg.source.installScripts ?? [];
  if (scripts.length > 0) {
    notes.push(t.t('plugins.confirm.scripts', { list: scripts.join(', ') }));
  }
  if ((pkg.unsupported ?? []).length > 0) {
    notes.push(t.t('plugins.unsupported', { list: (pkg.unsupported ?? []).join(', ') }));
  }
  const sections: string[] = [
    ...(about.length === 0 ? [] : [about.join('\n')]),
    source,
    ...(notes.length === 0 ? [] : [notes.join('\n')]),
  ];
  if (items.length === 0) {
    const parts = Object.entries(pkg.components)
      .filter(([, names]) => names.length > 0)
      .map(([kind, names]) => `${kind}: ${names.join(', ')}`);
    sections.push(t.t('plugins.noExecutables'), parts.join('\n'));
  } else {
    for (const kind of KINDS) {
      const names = items.filter((i) => i.kind === kind).map((i) => `• ${i.name}`);
      if (names.length > 0) sections.push(`${t.t(`plugins.exec.${kind}`)}\n${names.join('\n')}`);
    }
    if (items.some((i) => i.kind === 'piExtension')) sections.push(t.t('plugins.extensionNote'));
  }
  return { message: t.t(message, { id: pkg.id }), detail: sections.join('\n\n') };
}

const CANCELLED = JSON.stringify({ status: 'cancelled' });

/** Registers the extension packages' commands. */
export function registerPackageHandlers(
  registerHandler: RegisterHandler,
  core: PackagesCore,
  translator: () => Translator,
  confirm: NativeConfirm,
): void {
  registerHandler(IPC_CHANNELS.packagesList, (_event, [dir]) => core.packagesList(workspace(dir)));
  registerHandler(IPC_CHANNELS.packageInstall, (_event, [raw]) =>
    core.packageInstall(JSON.stringify(installInput(raw))),
  );
  registerHandler(IPC_CHANNELS.packageUpdate, (_event, [id, dir]) =>
    core.packageUpdate(packageId(id), workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.packageUninstall, (_event, [id, dir]) =>
    core.packageUninstall(packageId(id), workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.packageEnable, async (event, [id, enabled, where, dir]) => {
    const name = packageId(id);
    const target = scope(where);
    const root = workspace(dir);
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (target === 'project' && root === null) {
      throw new TypeError('the project scope needs a workspace');
    }
    if (!enabled) return core.packageSetEnabled(name, false, target, root, []);
    const pkg = listedPackage(await core.packagesList(root), name);
    if (pkg === undefined) throw new TypeError(`no package ${name} is installed`);
    const t = translator();
    const text = confirmationText(t, pkg, pkg.executables, 'plugins.confirmEnable', target);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!(await confirm.ask(window, text, [t.t('plugins.enable'), t.t('dialog.cancel')]))) {
      return CANCELLED;
    }
    return core.packageSetEnabled(
      name,
      true,
      target,
      root,
      pkg.executables.map((e) => e.name),
    );
  });
  registerHandler(IPC_CHANNELS.packageConfirm, async (event, [id, dir]) => {
    const name = packageId(id);
    const root = workspace(dir);
    const pkg = listedPackage(await core.packagesList(root), name);
    if (pkg === undefined) throw new TypeError(`no package ${name} is installed`);
    const pending = pkg.executables.filter((e) => !e.confirmed);
    if (pending.length === 0) return core.packagesList(root);
    const t = translator();
    const text = confirmationText(t, pkg, pending, 'plugins.confirmNew');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!(await confirm.ask(window, text, [t.t('plugins.allow'), t.t('dialog.cancel')]))) {
      return CANCELLED;
    }
    return core.packageConfirm(
      name,
      pending.map((e) => e.name),
      root,
    );
  });
}
