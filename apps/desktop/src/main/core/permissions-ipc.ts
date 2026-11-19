// The permission settings page (T23): rule lists by source, rule edits, and the audit view;
// the configuration diagnostics page (T24) reads the same settings files.
// A new or changed allow rule is shown in a native confirmation before Core saves it
// (architecture section 10.3); the page cannot skip it. Core checks the syntax and writes only
// PiArc's own files.
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import {
  IPC_CHANNELS,
  RULE_LAYERS,
  type AuditQuery,
  type PermissionRuleChange,
  type RuleBehavior,
  type RuleLayer,
} from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type PermissionCore = Pick<
  CoreRuntime,
  | 'permissionRules'
  | 'checkPermissionRule'
  | 'updatePermissionRule'
  | 'auditEvents'
  | 'configDiagnostics'
>;

const MAX_RULE = 4096;

function rule(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_RULE) {
    throw new TypeError(`${name} must be a rule of at most ${String(MAX_RULE)} characters`);
  }
  if (/[\r\n]/u.test(value)) throw new TypeError(`${name} must be one line`);
  return value;
}

function behavior(value: unknown): RuleBehavior {
  if (value !== 'allow' && value !== 'ask' && value !== 'deny') {
    throw new TypeError('behavior must be allow, ask or deny');
  }
  return value;
}

function workspace(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) {
    throw new TypeError('workspace must be an absolute path');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ruleChange(raw: unknown): PermissionRuleChange {
  if (!isRecord(raw)) throw new TypeError('invalid rule change');
  const layer = RULE_LAYERS.find((l): l is RuleLayer => l === raw.layer);
  if (layer === undefined) throw new TypeError('layer must be a writable settings file');
  const change: PermissionRuleChange = {
    workspace: workspace(raw.workspace),
    layer,
    behavior: behavior(raw.behavior),
    ...(raw.old === undefined ? {} : { old: rule(raw.old, 'old') }),
    ...(raw.rule === undefined ? {} : { rule: rule(raw.rule, 'rule') }),
  };
  if (change.old === undefined && change.rule === undefined) {
    throw new TypeError('a rule change needs a rule');
  }
  return change;
}

export function auditQuery(raw: unknown): AuditQuery {
  if (!isRecord(raw)) throw new TypeError('invalid audit query');
  const text = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new TypeError(`${name} must be a short string`);
    }
    return value;
  };
  const conclusion = raw.conclusion;
  if (conclusion !== undefined && conclusion !== 'allow' && conclusion !== 'deny') {
    throw new TypeError('conclusion must be allow or deny');
  }
  const number = (value: unknown, name: string, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
      throw new TypeError(`${name} must be an integer from 0 to ${String(max)}`);
    }
    return value;
  };
  return {
    ...(raw.workspace === undefined ? {} : { workspace: workspace(raw.workspace) }),
    ...(raw.sessionId === undefined ? {} : { sessionId: text(raw.sessionId, 'sessionId') }),
    ...(raw.tool === undefined ? {} : { tool: text(raw.tool, 'tool') }),
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(raw.since === undefined
      ? {}
      : { since: number(raw.since, 'since', Number.MAX_SAFE_INTEGER) }),
    limit: raw.limit === undefined ? 200 : number(raw.limit, 'limit', 1000),
  };
}

/** Registers the permission page's commands. */
export function registerPermissionHandlers(
  registerHandler: RegisterHandler,
  core: PermissionCore,
  translator: () => Translator,
): void {
  registerHandler(IPC_CHANNELS.permissionRules, (_event, [dir]) =>
    core.permissionRules(dir === null ? null : workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.configDiagnostics, (_event, [dir]) =>
    core.configDiagnostics(dir === null ? null : workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.permissionCheck, (_event, [text, list]) =>
    core.checkPermissionRule(rule(text, 'rule'), behavior(list)),
  );
  registerHandler(IPC_CHANNELS.permissionUpdate, async (event, [raw]) => {
    const change = ruleChange(raw);
    if (change.behavior === 'allow' && change.rule !== undefined) {
      const t = translator();
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        message: t.t('permissions.confirmAllow'),
        detail: [
          t.t('approval.rule') + '\n' + change.rule,
          ...(change.old === undefined ? [] : [t.t('permissions.replaces') + '\n' + change.old]),
          t.t('permissions.savedIn') + '\n' + t.t(`permissions.source.${change.layer}`),
          change.workspace,
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
    return core.updatePermissionRule(JSON.stringify(change));
  });
  registerHandler(IPC_CHANNELS.auditEvents, (_event, [raw]) =>
    core.auditEvents(JSON.stringify(auditQuery(raw))),
  );
}
