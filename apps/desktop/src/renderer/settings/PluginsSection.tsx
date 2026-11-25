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
import { reason } from '../shell/errors.js';

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
  readonly act: (label: string, run: () => Promise<string>) => void;
  readonly workspace: string | null;
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
    <li className="agent-row" data-testid="package-row" data-id={pkg.id}>
      <div className="agent-row-head">
        <strong>{pkg.id}</strong>
        <span className="muted small" data-testid="package-type">
          {t(`plugins.type.${pkg.kind}`)}
        </span>
        <span className="muted small" data-testid="package-state">
          {state}
        </span>
      </div>
      {pkg.description == null ? null : <p className="small">{pkg.description}</p>}
      <div className="muted small diagnostics-code package-source" data-testid="package-source">
        {source}
      </div>
      <div className="muted small">
        {t('plugins.scope')}:{' '}
        {t(scope === 'project' ? 'plugins.scope.project' : 'plugins.scope.user')}
      </div>
      <ul className="subagent-warnings" data-testid="package-components">
        {COMPONENT_LABELS.flatMap(([key, label]) => {
          const names = pkg.components[key] ?? [];
          return names.length === 0
            ? []
            : [
                <li key={key} className="muted small">
                  {t(label)}: {names.join(', ')}
                </li>,
              ];
        })}
      </ul>
      {(pkg.unsupported ?? []).length === 0 ? null : (
        <div className="muted small" data-testid="package-unsupported">
          {t('plugins.unsupported', { list: (pkg.unsupported ?? []).join(', ') })}
        </div>
      )}
      {pending.length === 0 || !pkg.enabled ? null : (
        <div className="error-text small" data-testid="package-pending">
          {t('plugins.pending', { count: pending.length })}
        </div>
      )}
      {(pkg.issues ?? []).map((issue) => (
        <div key={issue} className="error-text small">
          {issue}
        </div>
      ))}
      <div className="dialog-actions mcp-actions">
        {managed && <ManagedBadge testId="managed-package" />}
        {pkg.enabled ? (
          <Button
            size="small"
            data-testid="package-off"
            disabled={busy || managed}
            onClick={() => {
              act(pkg.id, () => window.piarc.setPackageEnabled(pkg.id, false, scope, where));
            }}
          >
            {t('plugins.turnOff')}
          </Button>
        ) : (
          <Button
            variant="primary"
            data-testid="package-on"
            disabled={busy || managed}
            onClick={() => {
              act(pkg.id, () => window.piarc.setPackageEnabled(pkg.id, true, scope, where));
            }}
          >
            {t('plugins.turnOn')}
          </Button>
        )}
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
        <Button
          size="small"
          data-testid="package-update"
          disabled={busy}
          onClick={() => {
            act(pkg.id, () => window.piarc.updatePackage(pkg.id, where));
          }}
        >
          {t('plugins.update')}
        </Button>
        <Button
          variant="destructive"
          size="small"
          data-testid="package-uninstall"
          disabled={busy}
          onClick={() => {
            if (!sure) {
              setSure(true);
              return;
            }
            setSure(false);
            act(pkg.id, () => window.piarc.uninstallPackage(pkg.id, workspace));
          }}
        >
          {sure ? t('plugins.uninstallSure', { id: pkg.id }) : t('plugins.uninstall')}
        </Button>
      </div>
    </li>
  );
}

function InstallForm({
  workspace,
  operation,
  act,
}: {
  readonly workspace: string | null;
  readonly operation: string | undefined;
  readonly act: (label: string, run: () => Promise<string>) => void;
}) {
  const { t } = useApp();
  const busy = operation !== undefined;
  const installing = operation === 'install';
  const kindId = useId();
  const locationId = useId();
  const scopeId = useId();
  const [kind, setKind] = useState<'directory' | 'git' | 'npm'>('directory');
  const [location, setLocation] = useState('');
  const [scope, setScope] = useState<PackageScope>('user');
  return (
    <form
      className="settings-install-form"
      data-testid="package-install"
      onSubmit={(e) => {
        e.preventDefault();
        if (location.trim() === '') return;
        act('install', () =>
          window.piarc.installPackage({
            kind,
            location: location.trim(),
            scope,
            ...(workspace === null ? {} : { workspace }),
          }),
        );
      }}
    >
      <div className="setting">
        <label htmlFor={kindId} className="setting-label">
          {t('plugins.kind')}
        </label>
        <select
          id={kindId}
          className="input"
          data-testid="package-kind"
          value={kind}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value === 'directory' || value === 'git' || value === 'npm') setKind(value);
          }}
        >
          <option value="directory">{t('plugins.kind.directory')}</option>
          <option value="git">{t('plugins.kind.git')}</option>
          <option value="npm">{t('plugins.kind.npm')}</option>
        </select>
      </div>
      <div className="setting">
        <label htmlFor={locationId} className="setting-label">
          {t('plugins.location')}
        </label>
        <input
          id={locationId}
          className="input"
          data-testid="package-location"
          value={location}
          onChange={(e) => {
            setLocation(e.currentTarget.value);
          }}
        />
      </div>
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
      <div className="setting">
        <label htmlFor={scopeId} className="setting-label">
          {t('plugins.scope')}
        </label>
        <select
          id={scopeId}
          className="input"
          data-testid="package-scope"
          value={scope}
          onChange={(e) => {
            setScope(e.currentTarget.value === 'project' ? 'project' : 'user');
          }}
        >
          <option value="user">{t('plugins.scope.user')}</option>
          {workspace === null ? null : (
            <option value="project">{t('plugins.scope.project')}</option>
          )}
        </select>
      </div>
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
    </form>
  );
}

/** The extension packages of the page, for `workspace` (or the user settings when null). */
export function PluginsSection({ workspace }: { readonly workspace: string | null }) {
  const { t } = useApp();
  const [list, setList] = useState<PackagesList | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState<string>();
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
    (label: string, run: () => Promise<string>) => {
      setOperation(label);
      setStatus('');
      run()
        .then((raw) => {
          if (isCancelled(raw)) {
            setStatus(t('plugins.cancelled'));
            return;
          }
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
        })
        .finally(() => {
          setOperation(undefined);
          load();
        });
    },
    [load, t],
  );
  return (
    <section data-testid="plugins-section">
      <h2 className="settings-heading">{t('plugins.title')}</h2>
      <p className="muted small">{t('plugins.hint')}</p>
      <h3 className="settings-heading">{t('plugins.installTitle')}</h3>
      <InstallForm workspace={workspace} operation={operation} act={act} />
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
          {list.packages.length === 0 ? <p className="muted">{t('plugins.none')}</p> : null}
          <ul className="agent-list" data-testid="package-list">
            {list.packages.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} busy={busy} act={act} workspace={workspace} />
            ))}
          </ul>
          {(list.missing ?? []).length === 0 ? null : (
            <p className="error-text small" data-testid="package-missing">
              {t('plugins.missing', { list: (list.missing ?? []).join(', ') })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
