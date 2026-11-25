// The Agent Hosts' proxy (ADR-0082): the system's, detected (the default), or an address the
// user sets. Model providers and sign-in go through it; this computer's own addresses never do.
// Saving goes through the preference channel; Core checks the address again and restarts idle
// Agent Hosts with the new proxy.
import { useEffect, useId, useState } from 'react';

import {
  PROXY_MODES,
  proxyUrlProblem,
  type ProxyMode,
  type ProxyUrlProblem,
} from '../../shared/preferences.js';
import { Button } from '../app/Button.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { InfoGlyph } from '../shell/icons.js';
import { ManagedBadge, useIsManaged } from './managed.js';

const PROBLEMS: Record<ProxyUrlProblem, `proxy.problem.${ProxyUrlProblem}`> = {
  scheme: 'proxy.problem.scheme',
  host: 'proxy.problem.host',
  port: 'proxy.problem.port',
  credentials: 'proxy.problem.credentials',
  path: 'proxy.problem.path',
};

export function ProxyPage() {
  const { t, preferences } = useApp();
  const { mode, url } = preferences.proxy;
  // The page's choice: picking "manual" shows the address field before anything is saved.
  const [chosen, setChosen] = useState<ProxyMode>(mode);
  const [draft, setDraft] = useState(url);
  // `undefined` while detecting; `null` for none.
  const [system, setSystem] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const managed = useIsManaged('/proxy');
  const modeLabel = useId();
  const addressId = useId();
  const errorId = useId();
  useEffect(() => {
    setChosen(mode);
  }, [mode]);
  useEffect(() => {
    setDraft(url);
  }, [url]);
  const detect = (): void => {
    setSystem(undefined);
    window.piarc.detectProxy().then(setSystem, (failure: unknown) => {
      setSystem(null);
      setError(reason(failure));
    });
  };
  useEffect(detect, []);
  const save = (value: { mode: ProxyMode; url?: string }): void => {
    setError(undefined);
    window.piarc.setPreference({ key: 'proxy', value }).catch((failure: unknown) => {
      setError(t('settings.saveFailed', { reason: reason(failure) }));
    });
  };
  const choose = (next: ProxyMode): void => {
    setChosen(next);
    setError(undefined);
    if (next === 'auto') save({ mode: 'auto' });
    // A saved address takes effect again at once; a new one waits for "Save".
    else if (url !== '' && proxyUrlProblem(url) === undefined) save({ mode: 'manual', url });
  };
  const saveAddress = (): void => {
    const problem = proxyUrlProblem(draft);
    if (problem !== undefined) {
      setError(t(PROBLEMS[problem]));
      return;
    }
    save({ mode: 'manual', url: draft.trim() });
  };
  const saved = mode === 'manual' && draft.trim() === url;
  return (
    <div className="preference-rows proxy-settings" data-testid="proxy-settings">
      <div className="preference-row">
        <div className="preference-copy">
          <span id={modeLabel} className="proxy-label">
            {t('proxy.mode')}
            <span
              className="proxy-info"
              role="img"
              tabIndex={0}
              aria-label={t('proxy.info')}
              data-tooltip={t('proxy.info')}
            >
              <InfoGlyph size={12} />
            </span>
            {managed && <ManagedBadge testId="managed-proxy" />}
          </span>
        </div>
        <SegmentedControl
          options={PROXY_MODES}
          value={chosen}
          onChange={choose}
          disabled={managed}
          name="proxy-mode"
          testIdPrefix="proxy-mode"
          aria-labelledby={modeLabel}
          labelOf={(option) => t(option === 'auto' ? 'proxy.mode.auto' : 'proxy.mode.manual')}
        />
      </div>
      {chosen === 'auto' ? (
        <div className="preference-row proxy-detected">
          <div className="preference-copy">
            <span className="proxy-system-label">{t('proxy.system')}</span>
            <span className="proxy-value" data-testid="proxy-system" aria-live="polite">
              {system === undefined
                ? t('proxy.system.detecting')
                : (system ?? t('proxy.system.none'))}
            </span>
          </div>
          <Button
            variant="ghost"
            data-testid="proxy-detect"
            loading={system === undefined}
            onClick={detect}
          >
            {t('proxy.detect')}
          </Button>
        </div>
      ) : (
        <form
          className="preference-row proxy-address"
          onSubmit={(event) => {
            event.preventDefault();
            saveAddress();
          }}
        >
          <label className="preference-copy" htmlFor={addressId}>
            {t('proxy.address')}
          </label>
          <span className="proxy-field">
            <input
              id={addressId}
              className="input"
              data-testid="proxy-url"
              value={draft}
              disabled={managed}
              placeholder={t('proxy.address.example')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={error !== undefined}
              aria-describedby={error === undefined ? undefined : errorId}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setError(undefined);
              }}
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="proxy-save"
              disabled={managed || saved || draft.trim() === ''}
            >
              {saved ? t('proxy.saved') : t('proxy.save')}
            </Button>
          </span>
        </form>
      )}
      {error !== undefined && (
        <p id={errorId} className="error-text" role="alert" data-testid="proxy-error">
          {error}
        </p>
      )}
    </div>
  );
}
