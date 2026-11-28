// The "Browser" settings page (design addendum B5.5): the agent's use of the browser and its
// allowed sites, browsing data, Chrome sign-in import (B5.1–B5.3, ADR-0090), local development
// names, links, search, downloads, DevTools and the site card timeout. Every value is the
// user's own (`browser.*` of the user settings file through the preference channel); a project
// file's `browser` keys are ignored and listed in configuration diagnostics.
import { PageHeadActions } from './page-head.js';
import { SettingsInfo, SettingsSection } from './layout.js';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';

import {
  BROWSER_APPROVAL_TIMEOUT,
  BROWSER_SEARCH_ENGINES,
  BROWSER_STORAGES,
  DEVTOOLS_DOCKS,
  type BrowserSearchEngine,
  type PreferenceChange,
} from '../../shared/preferences.js';
import { Button } from '../app/Button.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { parseWorkspaces } from './AgentsPage.js';
import { ChromeImportDialog } from './ChromeImportDialog.js';
import { WorkspaceOptions } from './WorkspaceOptions.js';
import { useImportTarget } from './browser-import-target.js';
import {
  agentSites,
  browserDomain,
  parseImports,
  splitNames,
  type ImportedSite,
} from './browser-settings.js';

const ENGINE_LABELS: Record<BrowserSearchEngine, `browserSettings.engine.${BrowserSearchEngine}`> =
  {
    google: 'browserSettings.engine.google',
    bing: 'browserSettings.engine.bing',
    duckduckgo: 'browserSettings.engine.duckduckgo',
    baidu: 'browserSettings.engine.baidu',
  };

function Section({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <SettingsSection title={title} testId={testId}>
      <div className="preference-rows">{children}</div>
    </SettingsSection>
  );
}

/**
 * One setting: its name and description at the start, its control at the trailing edge (the
 * settings pages' row, `controls.css`). `labelFor` names the control the title labels.
 */
function Row({
  title,
  description,
  titleId,
  labelFor,
  testId,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly titleId?: string;
  readonly labelFor?: string;
  readonly testId?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="preference-row" data-testid={testId}>
      <span className="preference-copy">
        {labelFor === undefined ? (
          <span id={titleId}>{title}</span>
        ) : (
          <label id={titleId} htmlFor={labelFor}>
            {title}
          </label>
        )}
        {description !== undefined && <span className="preference-description">{description}</span>}
      </span>
      {children !== undefined && <span className="browser-settings-control">{children}</span>}
    </div>
  );
}

function Switch({
  checked,
  label,
  hint,
  testId,
  onChange,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly testId: string;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <label className="preference-row">
      <span className="preference-copy">
        <span id={labelId}>{label}</span>
        {hint !== undefined && (
          <span id={hintId} className="preference-description">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        className="preference-switch"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        aria-labelledby={labelId}
        {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        onChange={(e) => {
          onChange(e.currentTarget.checked);
        }}
      />
    </label>
  );
}

/** The site card timeout, saved when the field loses focus or on Enter. */
function TimeoutField({
  value,
  onSave,
}: {
  readonly value: number;
  readonly onSave: (seconds: number) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const seconds = Number(draft);
    if (
      Number.isInteger(seconds) &&
      seconds >= BROWSER_APPROVAL_TIMEOUT.min &&
      seconds <= BROWSER_APPROVAL_TIMEOUT.max
    ) {
      if (seconds !== value) onSave(seconds);
    } else {
      setDraft(String(value));
    }
  };
  return (
    <Row
      title={t('browserSettings.timeout')}
      labelFor={id}
      description={
        <span id={hintId}>
          {t('browserSettings.timeoutHint', {
            min: BROWSER_APPROVAL_TIMEOUT.min,
            max: BROWSER_APPROVAL_TIMEOUT.max,
          })}
        </span>
      }
    >
      <input
        id={id}
        className="input browser-settings-number"
        type="number"
        min={BROWSER_APPROVAL_TIMEOUT.min}
        max={BROWSER_APPROVAL_TIMEOUT.max}
        step={1}
        value={draft}
        aria-describedby={hintId}
        data-testid="browser-approval-timeout"
        onChange={(e) => {
          setDraft(e.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </Row>
  );
}

/** Local development names: typed as a list, saved as a whole. */
function LocalNames({
  names,
  onSave,
}: {
  readonly names: readonly string[];
  readonly onSave: (names: readonly string[] | null) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const hintId = useId();
  const saved = names.join(', ');
  const [draft, setDraft] = useState(saved);
  // Follows the saved value only when it changes: every preferences update brings a new array,
  // and resetting on that would wipe what the user is typing.
  useEffect(() => {
    setDraft(saved);
  }, [saved]);
  return (
    <form
      className="preference-row browser-settings-stacked"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(splitNames(draft));
      }}
    >
      <span className="preference-copy">
        <label htmlFor={id}>{t('browserSettings.localNames')}</label>
        <span id={hintId} className="preference-description">
          {t('browserSettings.localNamesHint')}
        </span>
      </span>
      <span className="browser-settings-control">
        <input
          id={id}
          className="input browser-settings-names"
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={hintId}
          data-testid="browser-local-names"
          onChange={(e) => {
            setDraft(e.currentTarget.value);
          }}
        />
        <Button type="submit" size="small" data-testid="browser-local-names-save">
          {t('browserSettings.save')}
        </Button>
        <Button
          variant="ghost"
          size="small"
          data-testid="browser-local-names-reset"
          onClick={() => {
            onSave(null);
          }}
        >
          {t('browserSettings.restoreDefaults')}
        </Button>
      </span>
    </form>
  );
}

function ImportedSites({
  imports,
  onRemove,
}: {
  readonly imports: readonly ImportedSite[];
  readonly onRemove: (site: string) => void;
}) {
  const { t, format } = useApp();
  if (imports.length === 0) {
    return (
      <p className="muted" data-testid="browser-imports-empty">
        {t('browserSettings.importsEmpty')}
      </p>
    );
  }
  return (
    <ul className="permission-rules" data-testid="browser-imports">
      {imports.map((i) => (
        <li key={i.site} className="permission-rule" data-testid="browser-import-entry">
          <code>{i.site}</code>
          <span className="permission-badge">{t('browserImport.cookies', { count: i.count })}</span>
          <span className="muted">
            {t('browserSettings.importedFrom', {
              profile: i.profile,
              time: format.dateTime(i.importedAt),
            })}
          </span>
          <span className="permission-actions">
            <Button
              variant="destructive"
              size="small"
              aria-label={t('browserSettings.removeImport', { site: i.site })}
              data-testid="browser-import-remove"
              onClick={() => {
                onRemove(i.site);
              }}
            >
              {t('browserSettings.remove')}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BrowserPage() {
  const { t, preferences } = useApp();
  const browser = preferences.browser;
  const workspaceId = useId();
  const storageLabel = useId();
  const engineId = useId();
  const dockLabel = useId();
  const target = useImportTarget();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [imports, setImports] = useState<ImportedSite[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [rulesWorkspace, setRulesWorkspace] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ readonly forHost?: string } | null>(
    target === undefined ? null : { forHost: target.host },
  );
  const [clearing, setClearing] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const fail = useCallback((e: unknown) => {
    setError(reason(e));
  }, []);

  const save = (change: PreferenceChange) => {
    setError('');
    window.piarc.setPreference(change).catch((e: unknown) => {
      setError(t('settings.saveFailed', { reason: reason(e) }));
    });
  };

  useEffect(() => {
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        const known = parseWorkspaces(raw);
        const named = target?.workspace;
        setWorkspaces(
          named === undefined || known.workspaces.includes(named)
            ? known.workspaces
            : [named, ...known.workspaces],
        );
        setWorkspace((current) => current ?? named ?? known.workspace);
      })
      .catch(fail);
  }, [fail, target]);

  const loadImports = useCallback(() => {
    if (workspace === null) return;
    window.piarc
      .browserImports(workspace)
      .then((raw) => {
        setImports(parseImports(raw));
      })
      .catch(fail);
  }, [workspace, fail]);
  useEffect(loadImports, [loadImports]);

  const showRules = useCallback((raw: string) => {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return;
    if (Reflect.get(value, 'status') === 'cancelled') return;
    const named: unknown = Reflect.get(value, 'workspace');
    setRulesWorkspace(typeof named === 'string' ? named : null);
    setRules(agentSites(value));
  }, []);
  useEffect(() => {
    window.piarc.permissionRules(workspace).then(showRules).catch(fail);
  }, [workspace, showRules, fail]);

  const removeRule = (rule: string) => {
    const where = rulesWorkspace ?? workspace;
    if (where === null) return;
    window.piarc
      .updatePermissionRule({ workspace: where, layer: 'user', behavior: 'allow', old: rule })
      .then(showRules)
      .catch(fail);
  };

  const removeImport = (site: string) => {
    if (workspace === null) return;
    window.piarc.forgetBrowserImport(workspace, site).then(loadImports).catch(fail);
  };

  const clear = () => {
    if (workspace === null) return;
    if (clearing !== 'confirm') {
      setClearing('confirm');
      return;
    }
    setClearing('busy');
    window.piarc
      .clearBrowserData(workspace)
      .then(() => {
        setClearing('done');
        loadImports();
      })
      .catch((e: unknown) => {
        setClearing('idle');
        fail(e);
      });
  };

  const sessionOnly = browser.storage === 'session';
  return (
    <div className="settings-section settings-detail-page" data-testid="browser-page">
      <PageHeadActions>
        <SettingsInfo text={t('browserSettings.intro')} />
      </PageHeadActions>
      {error !== '' && (
        <p className="error-text" role="alert" data-testid="browser-settings-error">
          {error}
        </p>
      )}

      <Section title={t('browserSettings.pages')} testId="browser-pages-section">
        <Row title={t('browserSettings.searchEngine')} labelFor={engineId}>
          <select
            id={engineId}
            className="input"
            value={browser.searchEngine}
            data-testid="browser-search-engine"
            onChange={(e) => {
              const value = BROWSER_SEARCH_ENGINES.find((v) => v === e.currentTarget.value);
              if (value !== undefined) save({ key: 'browser.searchEngine', value });
            }}
          >
            {BROWSER_SEARCH_ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {t(ENGINE_LABELS[engine])}
              </option>
            ))}
          </select>
        </Row>
        <Row
          title={t('browserSettings.downloads')}
          description={
            <span data-testid="browser-download-location">
              {browser.downloadDirectory === null ? (
                t('browserSettings.downloadsAsk')
              ) : (
                <code>{browser.downloadDirectory}</code>
              )}
            </span>
          }
        >
          {browser.downloadDirectory !== null && (
            <Button
              variant="ghost"
              size="small"
              data-testid="browser-download-ask"
              onClick={() => {
                save({ key: 'browser.downloadDirectory', value: null });
              }}
            >
              {t('browserSettings.downloadsAskEach')}
            </Button>
          )}
          <Button
            size="small"
            data-testid="browser-download-choose"
            onClick={() => {
              window.piarc
                .chooseFolder()
                .then((folder) => {
                  if (folder !== null) save({ key: 'browser.downloadDirectory', value: folder });
                })
                .catch(fail);
            }}
          >
            {t('browserSettings.downloadsChoose')}
          </Button>
        </Row>
        <Row title={t('browserSettings.devtools')} titleId={dockLabel}>
          <SegmentedControl
            options={DEVTOOLS_DOCKS}
            value={browser.devtoolsDock}
            name="browser-devtools"
            testIdPrefix="browser-devtools"
            aria-labelledby={dockLabel}
            labelOf={(option) =>
              t(
                option === 'bottom'
                  ? 'browserSettings.devtools.bottom'
                  : 'browserSettings.devtools.right',
              )
            }
            onChange={(value) => {
              save({ key: 'browser.devtoolsDock', value });
            }}
          />
        </Row>
        <Switch
          checked={browser.openLocalLinks}
          label={t('browserSettings.openLocalLinks')}
          testId="browser-open-local-links"
          onChange={(value) => {
            save({ key: 'browser.openLocalLinks', value });
          }}
        />
        <LocalNames
          names={browser.localHostnames}
          onSave={(value) => {
            save({ key: 'browser.localHostnames', value });
          }}
        />
      </Section>

      <Section title={t('browserSettings.agent')} testId="browser-agent-section">
        <Switch
          checked={browser.agentEnabled}
          label={t('browserSettings.agentEnabled')}
          hint={t('browserSettings.agentEnabledHint')}
          testId="browser-agent-enabled"
          onChange={(value) => {
            save({ key: 'browser.agentEnabled', value });
          }}
        />
        <Switch
          checked={browser.revealOnAgentUse}
          label={t('browserSettings.reveal')}
          testId="browser-reveal"
          onChange={(value) => {
            save({ key: 'browser.revealOnAgentUse', value });
          }}
        />
        <TimeoutField
          value={browser.approvalTimeout}
          onSave={(value) => {
            save({ key: 'browser.approvalTimeout', value });
          }}
        />
        <Row
          title={t('browserSettings.agentSites')}
          description={t('browserSettings.agentSitesHint')}
        />
        <div className="browser-settings-list">
          {rules.length === 0 ? (
            <p className="muted" data-testid="browser-agent-sites-empty">
              {t('browserSettings.agentSitesEmpty')}
            </p>
          ) : (
            <ul className="permission-rules" data-testid="browser-agent-sites">
              {rules.map((rule) => (
                <li key={rule} className="permission-rule" data-testid="browser-agent-site">
                  <code>{browserDomain(rule)}</code>
                  <span className="permission-actions">
                    <Button
                      variant="destructive"
                      size="small"
                      aria-label={t('browserSettings.removeSite', {
                        site: browserDomain(rule) ?? rule,
                      })}
                      data-testid="browser-agent-site-remove"
                      onClick={() => {
                        removeRule(rule);
                      }}
                    >
                      {t('browserSettings.remove')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title={t('browserSettings.data')} testId="browser-data-section">
        <Row
          title={t('browserSettings.storage')}
          titleId={storageLabel}
          description={t('browserSettings.storageHint')}
        >
          <SegmentedControl
            options={BROWSER_STORAGES}
            value={browser.storage}
            name="browser-storage"
            testIdPrefix="browser-storage"
            aria-labelledby={storageLabel}
            labelOf={(option) =>
              t(
                option === 'persist'
                  ? 'browserSettings.storage.persist'
                  : 'browserSettings.storage.session',
              )
            }
            onChange={(value) => {
              save({ key: 'browser.storage', value });
            }}
          />
        </Row>
        {workspace === null ? (
          <p className="muted">{t('agents.noWorkspace')}</p>
        ) : (
          <>
            <Row title={t('permissions.workspace')} labelFor={workspaceId}>
              <select
                id={workspaceId}
                className="input"
                value={workspace}
                data-testid="browser-workspace"
                onChange={(e) => {
                  setWorkspace(e.currentTarget.value);
                  setClearing('idle');
                }}
              >
                <WorkspaceOptions workspaces={workspaces} />
              </select>
            </Row>
            <Row
              title={t('browserSettings.imports')}
              description={
                <>
                  {t('browserSettings.importsHint')}
                  {sessionOnly && (
                    <span className="browser-settings-note" data-testid="browser-import-disabled">
                      {t('browserImport.unavailable')}
                    </span>
                  )}
                </>
              }
            >
              <Button
                size="small"
                disabled={sessionOnly}
                data-testid="browser-import-open"
                onClick={() => {
                  setImporting({});
                }}
              >
                {t('browserSettings.import')}
              </Button>
            </Row>
            <div className="browser-settings-list">
              <ImportedSites imports={imports} onRemove={removeImport} />
            </div>
            <Row
              title={t('browserSettings.clearTitle')}
              description={
                clearing === 'done' ? (
                  <span role="status" data-testid="browser-clear-done">
                    {t('browserSettings.cleared')}
                  </span>
                ) : (
                  t('browserSettings.clearHint')
                )
              }
            >
              <Button
                variant="destructive"
                size="small"
                loading={clearing === 'busy'}
                data-testid="browser-clear-data"
                onClick={clear}
              >
                {clearing === 'confirm'
                  ? t('browserSettings.clearConfirm')
                  : t('browserSettings.clear')}
              </Button>
            </Row>
          </>
        )}
      </Section>

      {importing !== null && workspace !== null && !sessionOnly && (
        <ChromeImportDialog
          workspace={workspace}
          {...(importing.forHost === undefined ? {} : { forHost: importing.forHost })}
          onClose={() => {
            setImporting(null);
          }}
          onImported={loadImports}
        />
      )}
    </div>
  );
}
