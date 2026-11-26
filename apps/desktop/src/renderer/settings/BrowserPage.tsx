// The "Browser" settings page (design addendum B5.5): the agent's use of the browser and its
// allowed sites, browsing data, Chrome sign-in import (B5.1–B5.3, ADR-0090), local development
// names, links, search, downloads, DevTools and the site card timeout. Every value is the
// user's own (`browser.*` of the user settings file through the preference channel); a project
// file's `browser` keys are ignored and listed in configuration diagnostics.
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
import { takeImportTarget } from './browser-import-target.js';
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
    <section className="settings-subsection" data-testid={testId}>
      <h2 className="permission-heading">{title}</h2>
      {children}
    </section>
  );
}

function Check({
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
  const hintId = useId();
  return (
    <div className="setting">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          data-testid={testId}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
          onChange={(e) => {
            onChange(e.currentTarget.checked);
          }}
        />
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="muted">
          {hint}
        </p>
      )}
    </div>
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
    <div className="setting">
      <label htmlFor={id} className="setting-label">
        {t('browserSettings.timeout')}
      </label>
      <div className="browser-settings-row">
        <input
          id={id}
          className="input"
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
      </div>
      <p id={hintId} className="muted">
        {t('browserSettings.timeoutHint', {
          min: BROWSER_APPROVAL_TIMEOUT.min,
          max: BROWSER_APPROVAL_TIMEOUT.max,
        })}
      </p>
    </div>
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
  const [draft, setDraft] = useState(names.join(', '));
  useEffect(() => {
    setDraft(names.join(', '));
  }, [names]);
  return (
    <form
      className="setting"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(splitNames(draft));
      }}
    >
      <label htmlFor={id} className="setting-label">
        {t('browserSettings.localNames')}
      </label>
      <div className="browser-settings-row">
        <input
          id={id}
          className="input"
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
      </div>
      <p id={hintId} className="muted">
        {t('browserSettings.localNamesHint')}
      </p>
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
  const [target] = useState(takeImportTarget);
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
      <p className="muted">{t('browserSettings.intro')}</p>
      {error !== '' && (
        <p className="error-text" role="alert" data-testid="browser-settings-error">
          {error}
        </p>
      )}

      <Section title={t('browserSettings.agent')} testId="browser-agent-section">
        <Check
          checked={browser.agentEnabled}
          label={t('browserSettings.agentEnabled')}
          hint={t('browserSettings.agentEnabledHint')}
          testId="browser-agent-enabled"
          onChange={(value) => {
            save({ key: 'browser.agentEnabled', value });
          }}
        />
        <Check
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
        <div className="setting">
          <span className="setting-label">{t('browserSettings.agentSites')}</span>
          <p className="muted">{t('browserSettings.agentSitesHint')}</p>
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
        <fieldset className="setting">
          <legend id={storageLabel} className="setting-label">
            {t('browserSettings.storage')}
          </legend>
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
          <p className="muted">{t('browserSettings.storageHint')}</p>
        </fieldset>
        {workspace === null ? (
          <p className="muted">{t('agents.noWorkspace')}</p>
        ) : (
          <>
            <div className="setting">
              <label htmlFor={workspaceId} className="setting-label">
                {t('permissions.workspace')}
              </label>
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
            </div>
            <div className="setting">
              <div className="browser-settings-row">
                <Button
                  variant="destructive"
                  loading={clearing === 'busy'}
                  data-testid="browser-clear-data"
                  onClick={clear}
                >
                  {clearing === 'confirm'
                    ? t('browserSettings.clearConfirm')
                    : t('browserSettings.clear')}
                </Button>
                {clearing === 'done' && (
                  <span className="muted" role="status" data-testid="browser-clear-done">
                    {t('browserSettings.cleared')}
                  </span>
                )}
              </div>
              <p className="muted">{t('browserSettings.clearHint')}</p>
            </div>
            <div className="setting">
              <span className="setting-label">{t('browserSettings.imports')}</span>
              <p className="muted">{t('browserSettings.importsHint')}</p>
              <div className="browser-settings-row">
                <Button
                  disabled={sessionOnly}
                  data-testid="browser-import-open"
                  onClick={() => {
                    setImporting({});
                  }}
                >
                  {t('browserSettings.import')}
                </Button>
              </div>
              {sessionOnly && (
                <p className="muted" data-testid="browser-import-disabled">
                  {t('browserImport.unavailable')}
                </p>
              )}
              <ImportedSites imports={imports} onRemove={removeImport} />
            </div>
          </>
        )}
      </Section>

      <Section title={t('browserSettings.pages')} testId="browser-pages-section">
        <LocalNames
          names={browser.localHostnames}
          onSave={(value) => {
            save({ key: 'browser.localHostnames', value });
          }}
        />
        <Check
          checked={browser.openLocalLinks}
          label={t('browserSettings.openLocalLinks')}
          testId="browser-open-local-links"
          onChange={(value) => {
            save({ key: 'browser.openLocalLinks', value });
          }}
        />
        <div className="setting">
          <label htmlFor={engineId} className="setting-label">
            {t('browserSettings.searchEngine')}
          </label>
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
        </div>
        <div className="setting">
          <span className="setting-label">{t('browserSettings.downloads')}</span>
          <div className="browser-settings-row">
            <span data-testid="browser-download-location">
              {browser.downloadDirectory === null ? (
                t('browserSettings.downloadsAsk')
              ) : (
                <code>{browser.downloadDirectory}</code>
              )}
            </span>
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
          </div>
        </div>
        <fieldset className="setting">
          <legend id={dockLabel} className="setting-label">
            {t('browserSettings.devtools')}
          </legend>
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
        </fieldset>
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
