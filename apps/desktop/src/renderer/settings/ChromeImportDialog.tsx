// Importing sign-ins from Chrome (design addendum B5.1, ADR-0090): choose a Chrome profile,
// search and tick sites (none ticked, no "all"), then the main process shows its native
// confirmation and imports; the result lists each site's cookies and the ones skipped. The
// page never sees a cookie value.
import { useEffect, useId, useMemo, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { Button } from '../app/Button.js';
import { useApp } from '../app/app-context.js';
import { Dialog } from '../shell/Dialog.js';
import { reason } from '../shell/errors.js';
import { SearchIcon } from '../shell/icons.js';
import {
  parseOutcome,
  parseProfiles,
  parseSites,
  visibleSites,
  type ChromeProfile,
  type SiteCount,
  type SiteOutcome,
} from './browser-settings.js';

const MAX_SITES = 50;

const SKIP_REASONS: Record<string, MessageId> = {
  expired: 'browserImport.skip.expired',
  appBound: 'browserImport.skip.appBound',
  undecryptable: 'browserImport.skip.undecryptable',
  unknownFormat: 'browserImport.skip.unknownFormat',
  partitioned: 'browserImport.skip.partitioned',
  invalid: 'browserImport.skip.invalid',
  rejected: 'browserImport.skip.rejected',
};

type Step =
  | { readonly kind: 'loading' }
  | { readonly kind: 'noChrome' }
  | { readonly kind: 'choose'; readonly profiles: readonly ChromeProfile[] }
  | { readonly kind: 'done'; readonly sites: readonly SiteOutcome[] };

function Outcome({ sites }: { readonly sites: readonly SiteOutcome[] }) {
  const { t } = useApp();
  return (
    <ul className="permission-rules" data-testid="chrome-import-result">
      {sites.map((s) => (
        <li key={s.site} className="permission-rule" data-site={s.site}>
          <code>{s.site}</code>
          <span className="permission-badge">
            {t('browserImport.result.count', { count: s.imported })}
          </span>
          {s.skipped.map((k) => (
            <span key={k.reason} className="muted" data-reason={k.reason}>
              {t('browserImport.result.skipped', {
                count: k.count,
                reason: t(SKIP_REASONS[k.reason] ?? 'browserImport.skip.invalid'),
              })}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function ChromeImportDialog({
  workspace,
  forHost,
  onClose,
  onImported,
}: {
  readonly workspace: string;
  /** The page's host when opened from the site information menu. */
  readonly forHost?: string;
  readonly onClose: () => void;
  readonly onImported: () => void;
}) {
  const { t } = useApp();
  const titleId = useId();
  const profileId = useId();
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [profile, setProfile] = useState<string>('');
  const [sites, setSites] = useState<readonly SiteCount[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [onlyHost, setOnlyHost] = useState(forHost !== undefined);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.piarc
      .chromeProfiles()
      .then((raw) => {
        const { chrome, profiles } = parseProfiles(raw);
        if (!chrome || profiles.length === 0) {
          setStep({ kind: 'noChrome' });
          return;
        }
        setStep({ kind: 'choose', profiles });
        if (profiles.length === 1 && profiles[0] !== undefined) setProfile(profiles[0].id);
      })
      .catch((e: unknown) => {
        setError(reason(e));
        setStep({ kind: 'noChrome' });
      });
  }, []);

  useEffect(() => {
    if (profile === '') return;
    setSites(undefined);
    setChosen(new Set());
    setError('');
    window.piarc
      .chromeSites(profile)
      .then((raw) => {
        setSites(parseSites(raw));
      })
      .catch((e: unknown) => {
        setSites([]);
        setError(reason(e));
      });
  }, [profile]);

  const shown = useMemo(
    () => visibleSites(sites ?? [], query, onlyHost ? forHost : undefined),
    [sites, query, onlyHost, forHost],
  );

  const toggle = (site: string, on: boolean) => {
    setChosen((current) => {
      const next = new Set(current);
      if (on && next.size < MAX_SITES) next.add(site);
      else next.delete(site);
      return next;
    });
  };

  const submit = () => {
    if (chosen.size === 0) return;
    setBusy(true);
    setError('');
    window.piarc
      .chromeImport(workspace, profile, [...chosen])
      .then((raw) => {
        const outcome = parseOutcome(raw);
        if (outcome.status === 'cancelled') return;
        if (outcome.status === 'unavailable') {
          setError(t('browserImport.unavailable'));
          return;
        }
        setStep({ kind: 'done', sites: outcome.sites });
        onImported();
      })
      .catch((e: unknown) => {
        setError(reason(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      labelledBy={titleId}
      onCancel={onClose}
      testId="chrome-import-dialog"
      className="chrome-import"
      wide
      focusKey={step.kind}
    >
      <h2 id={titleId} className="dialog-title">
        {t('browserImport.title')}
      </h2>
      {step.kind === 'loading' && (
        <p className="muted" role="status">
          {t('browserImport.loading')}
        </p>
      )}
      {step.kind === 'noChrome' && (
        <p className="muted" data-testid="chrome-import-none">
          {t('browserImport.noChrome')}
        </p>
      )}
      {step.kind === 'choose' && (
        <>
          <p className="muted">{t('browserImport.hint')}</p>
          <div className="setting">
            <label htmlFor={profileId} className="setting-label">
              {t('browserImport.profile')}
            </label>
            <select
              id={profileId}
              className="input"
              value={profile}
              data-testid="chrome-import-profile"
              data-autofocus
              onChange={(e) => {
                setProfile(e.currentTarget.value);
              }}
            >
              <option value="" disabled>
                {t('browserImport.chooseProfile')}
              </option>
              {step.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {profile !== '' && (
            <div className="chrome-import-sites">
              <div className="service-search">
                <SearchIcon />
                <input
                  className="input"
                  type="search"
                  data-testid="chrome-import-search"
                  aria-label={t('browserImport.search')}
                  placeholder={t('browserImport.search')}
                  spellCheck={false}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                  }}
                />
              </div>
              {forHost !== undefined && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={onlyHost}
                    data-testid="chrome-import-only-host"
                    onChange={(e) => {
                      setOnlyHost(e.currentTarget.checked);
                    }}
                  />
                  {t('browserImport.onlyHost', { host: forHost })}
                </label>
              )}
              {sites === undefined ? (
                <p className="muted" role="status">
                  {t('browserImport.loadingSites')}
                </p>
              ) : shown.length === 0 ? (
                <p className="muted" data-testid="chrome-import-empty">
                  {t('browserImport.noSites')}
                </p>
              ) : (
                <ul
                  className="chrome-import-list"
                  aria-label={t('browserImport.sites')}
                  data-testid="chrome-import-sites"
                >
                  {shown.map((s) => (
                    <li key={s.site}>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          data-testid="chrome-import-site"
                          data-site={s.site}
                          checked={chosen.has(s.site)}
                          disabled={!chosen.has(s.site) && chosen.size >= MAX_SITES}
                          onChange={(e) => {
                            toggle(s.site, e.currentTarget.checked);
                          }}
                        />
                        <code>{s.site}</code>
                        <span className="muted">
                          {t('browserImport.cookies', { count: s.count })}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      {step.kind === 'done' && (
        <>
          <p className="muted" role="status">
            {t('browserImport.done')}
          </p>
          <Outcome sites={step.sites} />
        </>
      )}
      {error !== '' && (
        <p className="error-text" role="alert" data-testid="chrome-import-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {step.kind === 'choose' ? (
          <>
            <Button variant="secondary" onClick={onClose} data-testid="chrome-import-cancel">
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={chosen.size === 0 || busy}
              data-testid="chrome-import-submit"
              onClick={submit}
            >
              {t('browserImport.submit', { count: chosen.size })}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose} data-testid="chrome-import-close">
            {t('browserImport.close')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
