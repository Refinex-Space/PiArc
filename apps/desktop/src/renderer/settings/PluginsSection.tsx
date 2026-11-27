// Extension packages on the "Skills & plugins" page (T40): what is installed, where it applies,
// what it brings and what PiArc does not support; installing from a folder, a git URL or an
// npm spec; turning a package on or off (the main process confirms its source and executable
// items natively first), reviewing items an update added, updating and uninstalling.
import type {
  PackageComponents,
  PackageExecutable,
  PackageInfo,
  PackagesList,
  PackageScope,
} from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { ManagedBadge, pointerToken, useIsManaged } from './managed.js';
import { Button } from '../app/Button.js';
import { SettingsInfo, SettingsSection } from './layout.js';
import { reason } from '../shell/errors.js';
import { Dialog } from '../shell/Dialog.js';
import { ChevronDownIcon, PlusIcon } from '../shell/icons.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { RowMenu } from './ConnectionList.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function packageOf(raw: unknown): PackageInfo | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    (raw.kind !== 'claudePlugin' && raw.kind !== 'piPackage') ||
    !isRecord(raw.source) ||
    typeof raw.source.location !== 'string' ||
    typeof raw.path !== 'string'
  ) {
    return undefined;
  }
  const source = raw.source;
  const location = typeof source.location === 'string' ? source.location : '';
  const kind =
    source.kind === 'git' || source.kind === 'npm' || source.kind === 'directory'
      ? source.kind
      : 'directory';
  const components: PackageComponents = isRecord(raw.components)
    ? {
        commands: strings(raw.components.commands),
        skills: strings(raw.components.skills),
        agents: strings(raw.components.agents),
        hooks: strings(raw.components.hooks),
        mcpServers: strings(raw.components.mcpServers),
        extensions: strings(raw.components.extensions),
      }
    : {};
  const executables: PackageExecutable[] = (
    Array.isArray(raw.executables) ? raw.executables : []
  ).flatMap((e: unknown): PackageExecutable[] =>
    isRecord(e) &&
    typeof e.name === 'string' &&
    (e.kind === 'hook' ||
      e.kind === 'mcpServer' ||
      e.kind === 'piExtension' ||
      e.kind === 'agentHook' ||
      e.kind === 'agentMcpServer')
      ? [{ kind: e.kind, name: e.name, confirmed: e.confirmed === true }]
      : [],
  );
  const scope: PackageScope | undefined =
    raw.scope === 'user' || raw.scope === 'project' ? raw.scope : undefined;
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const commit = text(source.commit);
  const version = text(source.version);
  const description = text(raw.description);
  return {
    id: raw.id,
    kind: raw.kind,
    ...(description === undefined ? {} : { description }),
    source: {
      kind,
      location,
      ...(commit === undefined ? {} : { commit }),
      ...(version === undefined ? {} : { version }),
    },
    path: raw.path,
    ...(scope === undefined ? {} : { scope }),
    enabled: raw.enabled === true,
    active: raw.active === true,
    components,
    unsupported: strings(raw.unsupported),
    executables,
    issues: strings(raw.issues),
    installedAt: typeof raw.installedAt === 'number' ? raw.installedAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/** Core's `PackagesList`, with the members this page reads checked. */
export function parsePackages(text: string): PackagesList {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.packages)) throw new Error('Invalid package list');
  return {
    packages: value.packages.flatMap((p: unknown) => {
      const parsed = packageOf(p);
      return parsed === undefined ? [] : [parsed];
    }),
    missing: strings(value.missing),
  };
}

/** Whether an answer is the main process's "the user cancelled the confirmation". */
export function isCancelled(text: string): boolean {
  const value: unknown = JSON.parse(text);
  return isRecord(value) && value.status === 'cancelled';
}

const COMPONENT_LABELS: readonly [keyof PackageComponents, MessageId][] = [
  ['commands', 'plugins.components.commands'],
  ['skills', 'plugins.components.skills'],
  ['agents', 'plugins.components.agents'],
  ['hooks', 'plugins.components.hooks'],
  ['mcpServers', 'plugins.components.mcpServers'],
  ['extensions', 'plugins.components.extensions'],
];

function shortCommit(commit: string | undefined): string {
  return commit === undefined ? '' : commit.slice(0, 10);
}

interface RowProps {
  readonly pkg: PackageInfo;
  readonly busy: boolean;
  readonly act: (label: string, run: () => Promise<string>, done?: (ok: boolean) => void) => void;
  readonly workspace: string | null;
}

export const hintId = (name: string) => `uninstall-hint-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

/**
 * A visible "Uninstall" that asks once more in place (M-20): the first click arms it, the
 * second uninstalls; Escape, "Cancel" or leaving the controls disarms it. The caller shows
 * `plugins.uninstallConfirmHint` (id from `hintId`) while it is armed.
 */
export function UninstallButton({
  name,
  sure,
  busy,
  onSure,
  onUninstall,
}: {
  readonly name: string;
  readonly sure: boolean;
  readonly busy: boolean;
  readonly onSure: (sure: boolean) => void;
  readonly onUninstall: () => void;
}) {
  const { t } = useApp();
  if (!sure) {
    return (
      <Button
        variant="ghost"
        size="small"
        className="package-uninstall"
        disabled={busy}
        data-testid="package-uninstall-start"
        aria-label={t('plugins.uninstallNamed', { id: name })}
        onClick={() => {
          onSure(true);
        }}
      >
        {t('plugins.uninstall')}
      </Button>
    );
  }
  return (
    <span
      className="package-uninstall-confirm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onSure(false);
        }
      }}
    >
      <Button
        variant="ghost"
        size="small"
        data-testid="package-uninstall-cancel"
        onClick={() => {
          onSure(false);
        }}
      >
        {t('plugins.uninstallCancel')}
      </Button>
      <Button
        variant="destructive"
        size="small"
        data-testid="package-uninstall"
        disabled={busy}
        aria-describedby={hintId(name)}
        autoFocus
        onClick={() => {
          onSure(false);
          onUninstall();
        }}
      >
        {t('plugins.uninstallConfirm')}
      </Button>
    </span>
  );
}

function PackageRow({ pkg, busy, act, workspace }: RowProps) {
  const { t } = useApp();
  const [sure, setSure] = useState(false);
  const pending = (pkg.executables ?? []).filter((e) => !e.confirmed);
  const state = pkg.active
    ? t('plugins.state.on')
    : pkg.enabled
      ? t('plugins.state.waiting')
      : pkg.scope === undefined
        ? t('plugins.state.undeclared')
        : t('plugins.state.off');
  const scope: PackageScope = pkg.scope ?? 'user';
  const where = scope === 'project' ? workspace : null;
  const source = [
    t(`plugins.kind.${pkg.source.kind}`),
    pkg.source.location,
    shortCommit(pkg.source.commit ?? undefined),
    pkg.source.version ?? '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  // T47: a package the organization's settings switch on or off stays as they say.
  const managed = useIsManaged(`/plugins/${pointerToken(pkg.id)}`);
  return (
    <li
      className="package-row"
      data-testid="package-row"
      data-id={pkg.id}
      data-active={pkg.active || undefined}
    >
      <details className="package-details">
        <summary className="package-summary">
          <span className="package-text">
            <span className="package-name">
              <span className="mono-text">{pkg.id}</span>
              <span className="settings-badge" data-testid="package-type">
                {t(`plugins.type.${pkg.kind}`)}
              </span>
              {managed && <ManagedBadge testId="managed-package" />}
            </span>
            {pkg.description == null ? null : (
              <span className="package-description">{pkg.description}</span>
            )}
            <span className="package-meta">
              <span data-testid="package-state">{state}</span>
              {' · '}
              {t(scope === 'project' ? 'plugins.scope.project' : 'plugins.scope.user')}
              {' · '}
              {t(`plugins.kind.${pkg.source.kind}`)}
            </span>
          </span>
          <span className="diagnostics-chevron">
            <ChevronDownIcon />
          </span>
        </summary>
        <div className="package-body">
          <p className="mono-text package-source" data-testid="package-source">
            {source}
          </p>
          <ul className="package-components" data-testid="package-components">
            {COMPONENT_LABELS.flatMap(([key, label]) => {
              const names = pkg.components[key] ?? [];
              return names.length === 0
                ? []
                : [
                    <li key={key}>
                      {t(label)}: {names.join(', ')}
                    </li>,
                  ];
            })}
          </ul>
          {(pkg.unsupported ?? []).length === 0 ? null : (
            <p className="package-note" data-testid="package-unsupported">
              {t('plugins.unsupported', { list: (pkg.unsupported ?? []).join(', ') })}
            </p>
          )}
        </div>
      </details>
      <div className="package-actions">
        {pending.length === 0 || !pkg.enabled ? null : (
          <Button
            size="small"
            data-testid="package-review"
            disabled={busy}
            onClick={() => {
              act(pkg.id, () => window.piarc.confirmPackage(pkg.id, where));
            }}
          >
            {t('plugins.review')}
          </Button>
        )}
        <input
          type="checkbox"
          className="preference-switch"
          checked={pkg.enabled}
          disabled={busy || managed}
          aria-label={t('plugins.enabledNamed', { id: pkg.id })}
          data-testid={pkg.enabled ? 'package-off' : 'package-on'}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            act(pkg.id, () => window.piarc.setPackageEnabled(pkg.id, on, scope, where));
          }}
        />
        <UninstallButton
          name={pkg.id}
          sure={sure}
          busy={busy}
          onSure={setSure}
          onUninstall={() => {
            act(pkg.id, () => window.piarc.uninstallPackage(pkg.id, workspace));
          }}
        />
        <RowMenu
          label={t('plugins.more', { id: pkg.id })}
          testId={`package-more-${pkg.id}`}
          disabled={busy}
          items={[
            {
              id: 'update',
              testId: 'package-update',
              label: t('plugins.update'),
              run: () => {
                act(pkg.id, () => window.piarc.updatePackage(pkg.id, where));
              },
            },
          ]}
        />
      </div>
      {sure && (
        <p
          className="package-uninstall-hint"
          id={hintId(pkg.id)}
          data-testid="package-uninstall-hint"
        >
          {t('plugins.uninstallConfirmHint')}
        </p>
      )}
      {pending.length === 0 || !pkg.enabled ? null : (
        <p className="package-alert" data-testid="package-pending">
          {t('plugins.pending', { count: pending.length })}
        </p>
      )}
      {(pkg.issues ?? []).map((issue) => (
        <p key={issue} className="package-alert">
          {issue}
        </p>
      ))}
    </li>
  );
}

type SourceKind = 'directory' | 'git' | 'npm';

function InstallDialog({
  workspace,
  operation,
  act,
  onClose,
}: {
  readonly workspace: string | null;
  readonly operation: string | undefined;
  readonly act: (label: string, run: () => Promise<string>, done?: (ok: boolean) => void) => void;
  readonly onClose: () => void;
}) {
  const { t } = useApp();
  const busy = operation !== undefined;
  const installing = operation === 'install';
  const titleId = useId();
  const kindId = useId();
  const locationId = useId();
  const scopeId = useId();
  const [kind, setKind] = useState<SourceKind>('directory');
  const [location, setLocation] = useState('');
  const [scope, setScope] = useState<PackageScope>('user');
  const placeholder: Record<SourceKind, MessageId> = {
    directory: 'plugins.location.directory',
    git: 'plugins.location.git',
    npm: 'plugins.location.npm',
  };
  return (
    <Dialog
      labelledBy={titleId}
      onCancel={onClose}
      testId="package-install-dialog"
      className="mcp-add"
    >
      <form
        data-testid="package-install"
        onSubmit={(e) => {
          e.preventDefault();
          if (location.trim() === '') return;
          act(
            'install',
            () =>
              window.piarc.installPackage({
                kind,
                location: location.trim(),
                scope,
                ...(workspace === null ? {} : { workspace }),
              }),
            (ok) => {
              if (ok) onClose();
            },
          );
        }}
      >
        <h2 id={titleId} className="dialog-title">
          {t('plugins.installTitle')}
        </h2>
        <fieldset className="mcp-add-fields" disabled={busy}>
          <div className="mcp-add-field">
            <span className="mcp-add-label" id={kindId}>
              {t('plugins.kind')}
            </span>
            <SegmentedControl<SourceKind>
              aria-labelledby={kindId}
              name={`${kindId}-choice`}
              options={['directory', 'git', 'npm']}
              value={kind}
              labelOf={(v) => t(`plugins.kind.${v}`)}
              onChange={setKind}
              testIdPrefix="package-kind"
            />
          </div>
          <div className="mcp-add-field">
            <label htmlFor={locationId} className="mcp-add-label">
              {t('plugins.location')}
            </label>
            <div className="package-location-row">
              <input
                id={locationId}
                className="input mono-text"
                data-testid="package-location"
                data-autofocus
                spellCheck={false}
                placeholder={t(placeholder[kind])}
                value={location}
                onChange={(e) => {
                  setLocation(e.currentTarget.value);
                }}
              />
              {kind === 'directory' ? (
                <Button
                  size="small"
                  data-testid="package-choose"
                  onClick={() => {
                    void window.piarc.chooseFolder().then((path) => {
                      if (path !== null) setLocation(path);
                    });
                  }}
                >
                  {t('plugins.chooseFolder')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mcp-add-field">
            <span className="mcp-add-label" id={scopeId}>
              {t('plugins.scope')}
            </span>
            <SegmentedControl<PackageScope>
              aria-labelledby={scopeId}
              name={`${scopeId}-choice`}
              options={workspace === null ? ['user'] : ['user', 'project']}
              value={scope}
              labelOf={(v) => t(v === 'project' ? 'plugins.scope.project' : 'plugins.scope.user')}
              onChange={setScope}
              testIdPrefix="package-scope"
            />
          </div>
        </fieldset>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-testid="package-install-submit"
            loading={installing}
            aria-label={installing ? t('plugins.installing') : undefined}
            disabled={busy || location.trim() === ''}
          >
            {t('plugins.install')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The extension packages of the page, for `workspace` (or the user settings when null). */
/** An npm package name (the ids the market can install). */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function PluginsSection({
  workspace,
  onMarket,
}: {
  readonly workspace: string | null;
  /** Shows a package in the market (a declared package that is not installed). */
  readonly onMarket?: (name: string) => void;
}) {
  const { t } = useApp();
  const [list, setList] = useState<PackagesList | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState<string>();
  const [installing, setInstalling] = useState(false);
  const busy = operation !== undefined;
  const load = useCallback(() => {
    window.piarc
      .listPackages(workspace)
      .then((raw) => {
        setList(parsePackages(raw));
        setError('');
      })
      .catch((e: unknown) => {
        setError(t('plugins.failed', { reason: reason(e) }));
      });
  }, [workspace, t]);
  useEffect(load, [load]);
  const act = useCallback(
    (label: string, run: () => Promise<string>, done?: (ok: boolean) => void) => {
      setOperation(label);
      setStatus('');
      run()
        .then((raw) => {
          if (isCancelled(raw)) {
            setStatus(t('plugins.cancelled'));
            done?.(false);
            return;
          }
          done?.(true);
          const value: unknown = JSON.parse(raw);
          if (isRecord(value) && isRecord(value.package)) {
            const pkg = packageOf(value.package);
            const from =
              typeof value.previousCommit === 'string'
                ? shortCommit(value.previousCommit)
                : typeof value.previousVersion === 'string'
                  ? value.previousVersion
                  : undefined;
            if (pkg !== undefined) {
              setStatus(
                from === undefined
                  ? t('plugins.installed', { id: pkg.id })
                  : t('plugins.updated', {
                      id: pkg.id,
                      from,
                      to: shortCommit(pkg.source.commit ?? undefined) || (pkg.source.version ?? ''),
                    }),
              );
            }
            const notes = strings(value.notes);
            if (notes.length > 0) setStatus((s) => `${s} ${notes.join(' ')}`);
          }
        })
        .catch((e: unknown) => {
          setStatus(`${label}: ${reason(e)}`);
          done?.(false);
        })
        .finally(() => {
          setOperation(undefined);
          load();
        });
    },
    [load, t],
  );
  return (
    <SettingsSection
      title={t('plugins.title')}
      testId="plugins-section"
      aside={<SettingsInfo text={t('plugins.hint')} />}
    >
      {status === '' ? null : (
        <p className="muted small" data-testid="package-status" role="status">
          {status}
        </p>
      )}
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {list === undefined ? null : (
        <>
          {list.packages.length === 0 ? (
            <p className="settings-row-note package-empty">{t('plugins.none')}</p>
          ) : null}
          <ul className="package-list" data-testid="package-list">
            {list.packages.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} busy={busy} act={act} workspace={workspace} />
            ))}
            <li className="mcp-add-row">
              <button
                type="button"
                className="settings-add-link"
                data-testid="package-install-open"
                disabled={busy}
                onClick={() => {
                  setInstalling(true);
                }}
              >
                <PlusIcon />
                {t('plugins.installTitle')}
              </button>
            </li>
          </ul>
          {(list.missing ?? []).length === 0 ? null : (
            <ul className="package-missing" data-testid="package-missing">
              {(list.missing ?? []).map((id) => (
                <li key={id} data-id={id}>
                  <span className="package-missing-text">{t('plugins.missingOne', { id })}</span>
                  {onMarket !== undefined && NPM_NAME.test(id) && (
                    <Button
                      variant="ghost"
                      size="small"
                      data-testid="package-missing-market"
                      onClick={() => {
                        onMarket(id);
                      }}
                    >
                      {t('plugins.installFromMarket')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {installing ? (
        <InstallDialog
          workspace={workspace}
          operation={operation}
          act={act}
          onClose={() => {
            setInstalling(false);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
