// The sandbox page (T39, architecture section 6.10): turn the Bash sandbox on or off, choose
// whether sandboxed commands still ask, edit the allowed domains and the paths commands cannot
// read, and see where sandboxed commands may write and which project values do not apply. Only
// the user's own values are editable: Claude Code's, a project's and the organization's entries
// are listed read-only with their source. Core validates and saves; the main process confirms
// turning auto-approval on and adding domains natively. On Windows the switch is disabled and
// says why (requirement D7).
import { PageHeadActions } from './page-head.js';
import { ScopePicker } from './ScopePicker.js';
import { SettingsInfo, SettingsRow, SettingsSection } from './layout.js';
import { useCallback, useEffect, useId, useState } from 'react';
import { WorkspaceOptions } from './WorkspaceOptions.js';

import type { MessageId } from '../../shared/i18n/index.js';
import type { SandboxChange } from '../../shared/ipc.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { ManagedBadge, useIsManaged } from './managed.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon } from '../shell/icons.js';

type Origin = 'user' | 'claudeUser' | 'project' | 'enterprise';

interface Entry {
  readonly value: string;
  readonly origin: Origin;
  readonly editable: boolean;
}

interface Ignored {
  readonly layer: string;
  readonly file: string;
  readonly pointer: string;
  readonly reason: string;
}

export interface SandboxView {
  readonly workspaces: readonly string[];
  readonly workspace: string | null;
  readonly supported: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly autoAllow: boolean;
  readonly userDomains: readonly string[];
  readonly userDenyRead: readonly string[];
  readonly allowedDomains: readonly Entry[];
  readonly denyRead: readonly Entry[];
  readonly writable: readonly { readonly kind: string; readonly path: string }[];
  readonly ignored: readonly Ignored[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const ORIGINS: readonly Origin[] = ['user', 'claudeUser', 'project', 'enterprise'];

function entries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): Entry[] => {
    if (!isRecord(e) || typeof e.value !== 'string') return [];
    const origin = ORIGINS.find((o) => o === e.origin);
    return origin === undefined ? [] : [{ value: e.value, origin, editable: e.editable === true }];
  });
}

/** Core's `sandboxSettings` answer, validated. */
export function parseSandboxView(raw: string): SandboxView {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !isRecord(value.platform) || !isRecord(value.user)) {
    throw new Error('Invalid sandbox settings');
  }
  return {
    workspaces: strings(value.workspaces),
    workspace: typeof value.workspace === 'string' ? value.workspace : null,
    supported: value.platform.supported === true,
    available: value.platform.available === true,
    enabled: value.enabled === true,
    autoAllow: value.autoAllow === true,
    userDomains: strings(value.user.allowedDomains),
    userDenyRead: strings(value.user.denyRead),
    allowedDomains: entries(value.allowedDomains),
    denyRead: entries(value.denyRead),
    writable: Array.isArray(value.writable)
      ? value.writable.flatMap((w) =>
          isRecord(w) && typeof w.kind === 'string' && typeof w.path === 'string'
            ? [{ kind: w.kind, path: w.path }]
            : [],
        )
      : [],
    ignored: Array.isArray(value.ignored)
      ? value.ignored.flatMap((i): Ignored[] =>
          isRecord(i) &&
          typeof i.layer === 'string' &&
          typeof i.file === 'string' &&
          typeof i.pointer === 'string' &&
          typeof i.reason === 'string'
            ? [{ layer: i.layer, file: i.file, pointer: i.pointer, reason: i.reason }]
            : [],
        )
      : [],
  };
}

function writableLabel(kind: string): MessageId {
  switch (kind) {
    case 'workspace':
      return 'sandbox.writable.workspace';
    case 'added':
      return 'sandbox.writable.added';
    default:
      return 'sandbox.writable.sessionTmp';
  }
}

/** One editable list: the merged entries with their sources, removing and adding the user's. */
function EntryList({
  title,
  hint,
  entries: shown,
  own,
  placeholder,
  testId,
  disabled,
  managed,
  onSave,
}: {
  readonly title: MessageId;
  readonly hint: MessageId;
  readonly entries: readonly Entry[];
  readonly own: readonly string[];
  readonly placeholder: MessageId;
  readonly testId: string;
  readonly disabled: boolean;
  /** Only the organization's entries apply (T47, `allowManagedDomainsOnly`). */
  readonly managed: boolean;
  readonly onSave: (list: string[]) => void;
}) {
  const { t } = useApp();
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const others = shown.filter((e) => !e.editable);
  // The user's file as written (`~/.ssh`), not as resolved: that is what gets saved back.
  const ownRows = own;
  return (
    <SettingsSection
      testId={testId}
      title={
        <>
          {t(title)}
          {managed && <ManagedBadge testId={`${testId}-managed`} />}
        </>
      }
      aside={<SettingsInfo text={t(hint)} />}
    >
      <ul className="permission-rules">
        {ownRows.map((value) => (
          <li key={`own:${value}`} className="permission-rule" data-testid={`${testId}-entry`}>
            <code>{value}</code>
            <span className="permission-badge">{t('sandbox.origin.user')}</span>
            <span className="permission-actions">
              <IconButton
                size="xs"
                className="settings-remove"
                disabled={disabled}
                label={t('sandbox.remove', { value })}
                data-testid={`${testId}-remove`}
                onClick={() => {
                  onSave(ownRows.filter((v) => v !== value));
                }}
              >
                <CloseIcon />
              </IconButton>
            </span>
          </li>
        ))}
        {others.map((e) => (
          <li
            key={`${e.origin}:${e.value}`}
            className="permission-rule"
            data-testid={`${testId}-entry`}
            data-readonly="true"
          >
            <code>{e.value}</code>
            <span className="permission-badge">{t(`sandbox.origin.${e.origin}`)}</span>
            <span className="muted">{t('sandbox.readOnly')}</span>
          </li>
        ))}
      </ul>
      <form
        className="permission-editor"
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          if (value === '' || ownRows.includes(value)) return;
          onSave([...ownRows, value]);
          setDraft('');
        }}
      >
        <input
          id={inputId}
          aria-label={t(placeholder)}
          className="input"
          placeholder={t(placeholder)}
          value={draft}
          disabled={disabled}
          data-testid={`${testId}-input`}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
        />
        <Button type="submit" size="small" disabled={disabled || draft.trim() === ''}>
          {t('sandbox.add')}
        </Button>
      </form>
    </SettingsSection>
  );
}

const SANDBOX_MODES = ['ask', 'auto'] as const;

export function SandboxPage() {
  const modeLabel = useId();
  const { t } = useApp();
  const [view, setView] = useState<SandboxView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const workspaceId = useId();
  const enabledId = useId();
  // T47: settings the organization manages stay read-only here.
  const managedEnabled = useIsManaged('/sandbox/enabled');
  const managedMode = useIsManaged('/sandbox/autoAllowBashIfSandboxed');
  const managedDomains = useIsManaged('/sandbox/network/allowedDomains');
  const show = useCallback((raw: string) => {
    const value: unknown = JSON.parse(raw);
    // A cancelled native confirmation leaves the view as it is.
    if (isRecord(value) && value.status === 'cancelled') return;
    setError('');
    setView(parseSandboxView(raw));
  }, []);
  const load = useCallback(
    (workspace: string | null) => {
      window.piarc
        .sandboxSettings(workspace)
        .then(show)
        .catch((e: unknown) => {
          setError(reason(e));
        });
    },
    [show],
  );
  useEffect(() => {
    load(null);
  }, [load]);
  const save = (change: SandboxChange) => {
    setBusy(true);
    window.piarc
      .setSandboxSettings(view?.workspace ?? null, change)
      .then(show)
      .catch((e: unknown) => {
        setError(reason(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  if (view === undefined) {
    return error === '' ? null : (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }
  const off = !view.supported;
  return (
    <div className="settings-section settings-detail-page" data-testid="sandbox-page">
      <PageHeadActions>
        <SettingsInfo text={t('sandbox.intro')} />
      </PageHeadActions>
      {view.workspaces.length > 0 && (
        <PageHeadActions>
          <ScopePicker>
            <select
              id={workspaceId}
              aria-label={t('sandbox.workspace')}
              className="settings-scope-select"
              value={view.workspace ?? ''}
              data-testid="sandbox-workspace"
              onChange={(e) => {
                load(e.currentTarget.value);
              }}
            >
              <WorkspaceOptions workspaces={view.workspaces} />
            </select>
          </ScopePicker>
        </PageHeadActions>
      )}
      {view.workspace === null && <p className="muted">{t('sandbox.noWorkspace')}</p>}
      <SettingsSection
        title={t('settings.sandbox')}
        aside={
          <Button
            size="small"
            variant="ghost"
            data-testid="sandbox-audit"
            onClick={() => {
              window.location.hash = '#/settings/permissions?audit=sandbox';
            }}
          >
            {t('sandbox.audit')}
          </Button>
        }
      >
        <SettingsRow
          label={t('sandbox.enabled')}
          htmlFor={enabledId}
          badge={managedEnabled && <ManagedBadge testId="managed-sandbox-enabled" />}
          description={
            <>
              <span id="sandbox-enabled-hint" data-testid="sandbox-enabled-hint">
                {off ? t('sandbox.unsupported') : t('sandbox.enabledHint')}
              </span>
              {view.supported && !view.available && (
                <span className="error-text" data-testid="sandbox-unavailable">
                  {' '}
                  {t('sandbox.unavailable')}
                </span>
              )}
            </>
          }
        >
          <input
            id={enabledId}
            type="checkbox"
            className="preference-switch"
            checked={view.supported && view.enabled}
            disabled={off || busy || managedEnabled}
            aria-describedby="sandbox-enabled-hint"
            data-testid="sandbox-enabled"
            onChange={(e) => {
              save({ enabled: e.currentTarget.checked });
            }}
          />
        </SettingsRow>
        <SettingsRow
          testId="sandbox-mode"
          label={t('sandbox.mode')}
          labelId={modeLabel}
          badge={managedMode && <ManagedBadge testId="managed-sandbox-mode" />}
          description={t('sandbox.modeHint')}
        >
          <SegmentedControl
            options={SANDBOX_MODES}
            value={view.autoAllow ? 'auto' : 'ask'}
            name="sandbox-mode"
            testIdPrefix="sandbox-mode"
            aria-labelledby={modeLabel}
            disabled={off || busy || managedMode}
            labelOf={(mode) => t(mode === 'auto' ? 'sandbox.mode.auto' : 'sandbox.mode.ask')}
            onChange={(mode) => {
              save({ autoAllow: mode === 'auto' });
            }}
          />
        </SettingsRow>
      </SettingsSection>
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <EntryList
        title="sandbox.domains"
        hint="sandbox.domainsHint"
        entries={view.allowedDomains}
        own={view.userDomains}
        placeholder="sandbox.newDomain"
        testId="sandbox-domains"
        disabled={off || busy || managedDomains}
        managed={managedDomains}
        onSave={(list) => {
          save({ allowedDomains: list });
        }}
      />
      <EntryList
        title="sandbox.denyRead"
        hint="sandbox.denyReadHint"
        entries={view.denyRead}
        own={view.userDenyRead}
        placeholder="sandbox.newPath"
        testId="sandbox-deny-read"
        disabled={off || busy}
        managed={false}
        onSave={(list) => {
          save({ denyRead: list });
        }}
      />
      <SettingsSection
        testId="sandbox-writable"
        title={t('sandbox.writable')}
        aside={<SettingsInfo text={t('sandbox.limits')} />}
      >
        <ul className="permission-rules">
          {view.writable.map((w) => (
            <li key={`${w.kind}:${w.path}`} className="permission-rule">
              <span className="permission-badge">{t(writableLabel(w.kind))}</span>
              <code>{w.path}</code>
            </li>
          ))}
        </ul>
      </SettingsSection>
      {view.ignored.length > 0 && (
        <SettingsSection testId="sandbox-ignored" title={t('sandbox.ignored')}>
          <ul className="permission-rules">
            {view.ignored.map((i) => (
              <li key={`${i.layer}:${i.pointer}`} className="permission-rule">
                <code>{i.pointer}</code>
                <span className="muted">{i.file}</span>
                <span className="permission-badge is-ask">
                  {t(
                    i.reason === 'platform'
                      ? 'diagnostics.reason.platform'
                      : 'diagnostics.reason.projectSandbox',
                  )}
                </span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
    </div>
  );
}
