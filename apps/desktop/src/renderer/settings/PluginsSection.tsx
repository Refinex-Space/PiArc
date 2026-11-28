// Extension packages on the "Skills & plugins" page (T40, ADR-0102): the installed packages as
// rows (on or off at a glance), a package's page (what it brings, where it came from, what PiArc
// does not support; update, uninstall, review new items), the Pi extensions they bring, and the
// install dialog (a folder, a git URL or an npm spec). Turning a package on goes through the main
// process's native confirmation of its source and executable items.
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
import { Dialog } from '../shell/Dialog.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import {
  CatalogEmpty,
  CatalogList,
  CatalogRow,
  DetailHead,
  InfoSection,
  type InfoItem,
} from './catalog.js';

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
  const integrity = text(source.integrity);
  const npmName = text(source.npmName);
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
      ...(integrity === undefined ? {} : { integrity }),
      ...(npmName === undefined ? {} : { npmName }),
      installScripts: strings(source.installScripts),
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

export type PackageAct = (
  label: string,
  run: () => Promise<string>,
  done?: (ok: boolean) => void,
) => void;

/** The installed packages for `workspace` (the user settings when null) and the one way to act on
 * them: one operation at a time, its outcome as a status line, the list read again after it. */
export function usePackages(workspace: string | null) {
  const { t } = useApp();
  const [list, setList] = useState<PackagesList | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState<string>();
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
  const act: PackageAct = useCallback(
    (label, run, done) => {
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
  return { list, error, status, operation, busy: operation !== undefined, act, load };
}

export type Packages = ReturnType<typeof usePackages>;

/** What the switch of a package says for the workspace shown. */
export function packageState(t: (id: MessageId) => string, pkg: PackageInfo): string {
  return pkg.active
    ? t('plugins.state.on')
    : pkg.enabled
      ? t('plugins.state.waiting')
      : pkg.scope === undefined
        ? t('plugins.state.undeclared')
        : t('plugins.state.off');
}

/** The status line of the last operation and the list's error, above the rows. */
export function PackageNotices({ packages }: { readonly packages: Packages }) {
  return (
    <>
      {packages.status !== '' && (
        <p className="catalog-notice is-plain" data-testid="package-status" role="status">
          {packages.status}
        </p>
      )}
      {packages.error !== '' && (
        <p className="catalog-notice is-danger" role="alert">
          {packages.error}
        </p>
      )}
    </>
  );
}

function PackageSwitch({
  pkg,
  packages,
  workspace,
}: {
  readonly pkg: PackageInfo;
  readonly packages: Packages;
  readonly workspace: string | null;
}) {
  const { t } = useApp();
  // T47: a package the organization's settings switch on or off stays as they say.
  const managed = useIsManaged(`/plugins/${pointerToken(pkg.id)}`);
  const scope: PackageScope = pkg.scope ?? 'user';
  const where = scope === 'project' ? workspace : null;
  return (
    <>
      {managed && <ManagedBadge testId="managed-package" />}
      <input
        type="checkbox"
        className="preference-switch"
        checked={pkg.enabled}
        disabled={packages.busy || managed}
        aria-label={t('plugins.enabledNamed', { id: pkg.id })}
        data-testid={pkg.enabled ? 'package-off' : 'package-on'}
        onChange={(e) => {
          const on = e.currentTarget.checked;
          packages.act(pkg.id, () => window.piarc.setPackageEnabled(pkg.id, on, scope, where));
        }}
      />
    </>
  );
}

/** The installed packages as rows: name, type, one line, state and switch; a row opens its page. */
export function PackageRows({
  packages,
  workspace,
  query,
  onOpen,
}: {
  readonly packages: Packages;
  readonly workspace: string | null;
  readonly query: string;
  readonly onOpen: (id: string) => void;
}) {
  const { t } = useApp();
  const list = packages.list;
  if (list === undefined) return null;
  const needle = query.trim().toLowerCase();
  const shown = list.packages.filter(
    (p) =>
      needle === '' ||
      p.id.toLowerCase().includes(needle) ||
      (p.description ?? '').toLowerCase().includes(needle),
  );
  if (list.packages.length === 0) {
    return <CatalogEmpty testId="package-empty">{t('plugins.none')}</CatalogEmpty>;
  }
  if (shown.length === 0) return <CatalogEmpty>{t('catalog.noMatch')}</CatalogEmpty>;
  return (
    <CatalogList testId="package-list">
      {shown.map((pkg) => {
        const pending = (pkg.executables ?? []).filter((e) => !e.confirmed).length;
        return (
          <CatalogRow
            key={pkg.id}
            kind="package"
            testId="package-row"
            data={{ id: pkg.id, active: pkg.active ? 'true' : undefined }}
            title={pkg.id}
            note={
              pending > 0 && pkg.enabled ? (
                <span className="catalog-row-note is-attention" data-testid="package-pending-note">
                  {t('plugins.pending', { count: pending })}
                </span>
              ) : (
                <span data-testid="package-type">{t(`plugins.type.${pkg.kind}`)}</span>
              )
            }
            description={
              pkg.description ??
              [t(`plugins.kind.${pkg.source.kind}`), pkg.source.version ?? '']
                .filter((part) => part !== '')
                .join(' · ')
            }
            openLabel={t('catalog.open', { name: pkg.id })}
            onOpen={() => {
              onOpen(pkg.id);
            }}
            trailing={
              <>
                <span className="catalog-row-meta" data-testid="package-state">
                  {packageState(t, pkg)}
                </span>
                <PackageSwitch pkg={pkg} packages={packages} workspace={workspace} />
              </>
            }
          />
        );
      })}
    </CatalogList>
  );
}

/** The Pi extensions the installed packages bring; a row opens its package's page. */
export function ExtensionRows({
  packages,
  query,
  onOpen,
}: {
  readonly packages: Packages;
  readonly query: string;
  readonly onOpen: (id: string) => void;
}) {
  const { t } = useApp();
  const list = packages.list;
  if (list === undefined) return null;
  const all = list.packages.flatMap((pkg) =>
    (pkg.components.extensions ?? []).map((entry) => ({ pkg, entry })),
  );
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    ({ pkg, entry }) =>
      needle === '' ||
      entry.toLowerCase().includes(needle) ||
      pkg.id.toLowerCase().includes(needle),
  );
  if (all.length === 0) {
    return <CatalogEmpty testId="extension-empty">{t('catalog.extensions.none')}</CatalogEmpty>;
  }
  if (shown.length === 0) return <CatalogEmpty>{t('catalog.noMatch')}</CatalogEmpty>;
  return (
    <CatalogList testId="extension-list">
      {shown.map(({ pkg, entry }) => (
        <CatalogRow
          key={`${pkg.id}/${entry}`}
          kind="extension"
          testId="extension-row"
          data={{ name: entry, package: pkg.id }}
          title={entry}
          note={pkg.id}
          description={pkg.description ?? t('catalog.extensions.from', { id: pkg.id })}
          openLabel={t('catalog.open', { name: pkg.id })}
          onOpen={() => {
            onOpen(pkg.id);
          }}
          trailing={<span className="catalog-row-meta">{packageState(t, pkg)}</span>}
        />
      ))}
    </CatalogList>
  );
}

/** An npm package name (the ids the market can install). */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Packages the settings turn on that are not installed, with the market's install for npm names. */
export function MissingPackages({
  packages,
  onMarket,
}: {
  readonly packages: Packages;
  readonly onMarket: (name: string) => void;
}) {
  const { t } = useApp();
  const missing = packages.list?.missing ?? [];
  if (missing.length === 0) return null;
  return (
    <ul className="catalog-warnings package-missing" data-testid="package-missing">
      {missing.map((id) => (
        <li key={id} data-id={id}>
          <span className="package-missing-text">{t('plugins.missingOne', { id })}</span>
          {NPM_NAME.test(id) && (
            <button
              type="button"
              className="catalog-link"
              data-testid="package-missing-market"
              onClick={() => {
                onMarket(id);
              }}
            >
              {t('plugins.installFromMarket')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A package's page: its head with update and uninstall, what it brings, where it came from. */
export function PackageDetail({
  id,
  packages,
  workspace,
  onGone,
}: {
  readonly id: string;
  readonly packages: Packages;
  readonly workspace: string | null;
  /** The package is no longer installed (uninstalled here or elsewhere). */
  readonly onGone: () => void;
}) {
  const { t, format } = useApp();
  const [sure, setSure] = useState(false);
  const pkg = packages.list?.packages.find((p) => p.id === id);
  useEffect(() => {
    if (packages.list !== undefined && pkg === undefined) onGone();
  }, [packages.list, pkg, onGone]);
  if (pkg === undefined) return null;
  const pending = (pkg.executables ?? []).filter((e) => !e.confirmed);
  const scope: PackageScope = pkg.scope ?? 'user';
  const where = scope === 'project' ? workspace : null;
  const components = COMPONENT_LABELS.flatMap(([key, label]) => {
    const names = pkg.components[key] ?? [];
    return names.length === 0 ? [] : [{ label: t(label), value: names.join(', ') }];
  });
  const about: InfoItem[] = [
    { label: t('catalog.about.type'), value: t(`plugins.type.${pkg.kind}`) },
    {
      label: t('catalog.about.source'),
      value: (
        <span>
          {t(`plugins.kind.${pkg.source.kind}`)}
          {' · '}
          <span className="mono-text" data-testid="package-source">
            {pkg.source.location}
          </span>
        </span>
      ),
    },
    ...(pkg.source.version == null
      ? []
      : [{ label: t('catalog.about.version'), value: pkg.source.version }]),
    ...(pkg.source.commit == null
      ? []
      : [
          {
            label: t('catalog.about.commit'),
            value: <span className="mono-text">{shortCommit(pkg.source.commit)}</span>,
          },
        ]),
    ...(pkg.source.integrity == null
      ? []
      : [
          {
            label: t('catalog.about.integrity'),
            value: <span className="mono-text">{pkg.source.integrity}</span>,
          },
        ]),
    {
      label: t('catalog.about.scope'),
      value:
        pkg.scope === undefined
          ? t('plugins.state.undeclared')
          : t(pkg.scope === 'project' ? 'plugins.scope.project' : 'plugins.scope.user'),
    },
    ...(pkg.installedAt > 0
      ? [{ label: t('catalog.about.installed'), value: format.dateTime(pkg.installedAt) }]
      : []),
    ...(pkg.updatedAt > 0 && pkg.updatedAt !== pkg.installedAt
      ? [{ label: t('catalog.about.updated'), value: format.dateTime(pkg.updatedAt) }]
      : []),
    ...(pkg.path === pkg.source.location
      ? []
      : [
          {
            label: t('catalog.about.path'),
            value: <span className="mono-text">{pkg.path}</span>,
          },
        ]),
  ];
  return (
    <div className="catalog-detail" data-testid="package-detail" data-id={pkg.id}>
      <DetailHead
        kind="package"
        title={pkg.id}
        subtitle={[t(`plugins.type.${pkg.kind}`), pkg.description ?? '']
          .filter((part) => part !== '')
          .join(' · ')}
        actions={
          <>
            {pending.length > 0 && pkg.enabled && (
              <Button
                size="small"
                data-testid="package-review"
                disabled={packages.busy}
                onClick={() => {
                  packages.act(pkg.id, () => window.piarc.confirmPackage(pkg.id, where));
                }}
              >
                {t('plugins.review')}
              </Button>
            )}
            <Button
              size="small"
              data-testid="package-update"
              disabled={packages.busy}
              onClick={() => {
                packages.act(pkg.id, () => window.piarc.updatePackage(pkg.id, where));
              }}
            >
              {t('plugins.update')}
            </Button>
            <UninstallButton
              name={pkg.id}
              sure={sure}
              busy={packages.busy}
              onSure={setSure}
              onUninstall={() => {
                packages.act(pkg.id, () => window.piarc.uninstallPackage(pkg.id, workspace));
              }}
            />
            <span className="catalog-switch">
              <span className="catalog-row-meta" data-testid="package-state">
                {packageState(t, pkg)}
              </span>
              <PackageSwitch pkg={pkg} packages={packages} workspace={workspace} />
            </span>
          </>
        }
      />
      {sure && (
        <p
          className="package-uninstall-hint"
          id={hintId(pkg.id)}
          data-testid="package-uninstall-hint"
        >
          {t('plugins.uninstallConfirmHint')}
        </p>
      )}
      <PackageNotices packages={packages} />
      {(pending.length > 0 && pkg.enabled) || (pkg.issues ?? []).length > 0 ? (
        <ul className={`catalog-warnings${(pkg.issues ?? []).length > 0 ? ' is-danger' : ''}`}>
          {pending.length > 0 && pkg.enabled && (
            <li data-testid="package-pending">{t('plugins.pending', { count: pending.length })}</li>
          )}
          {(pkg.issues ?? []).map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {components.length > 0 && (
        <InfoSection
          title={t('catalog.section.brings')}
          items={components}
          testId="package-components"
        />
      )}
      <InfoSection title={t('catalog.section.about')} items={about} testId="package-about">
        {(pkg.unsupported ?? []).length > 0 && (
          <p className="catalog-note" data-testid="package-unsupported">
            {t('plugins.unsupported', { list: (pkg.unsupported ?? []).join(', ') })}
          </p>
        )}
      </InfoSection>
    </div>
  );
}

type SourceKind = 'directory' | 'git' | 'npm';

export function InstallDialog({
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
