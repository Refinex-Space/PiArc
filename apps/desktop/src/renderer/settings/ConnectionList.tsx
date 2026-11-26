// The provider connections (T21, T29, ADR-0083): the signed-in accounts, grouped by provider
// with the one in use first, and the configured providers. Each provider can be turned off and
// tested; an account aside can be put in use or removed.
import { useEffect, useState } from 'react';

import { useApp, useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import {
  accountsByProvider,
  hasEndpoint,
  makeForm,
  parseTestResult,
  takesKey,
  type Account,
  type LoginProvider,
  type Provider,
  type ProviderSettings,
  type TestResult,
} from './provider-form.js';

/** The host of an endpoint's base URL, or the URL as written when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Test = { readonly state: 'running' } | { readonly state: 'done'; readonly result: TestResult };

/** A connection test per provider, shown under its row. */
function useTests(): {
  readonly tests: Readonly<Record<string, Test>>;
  readonly run: (id: string) => void;
} {
  const [tests, setTests] = useState<Record<string, Test>>({});
  const run = (id: string) => {
    setTests((old) => ({ ...old, [id]: { state: 'running' } }));
    void window.piarc
      .testProvider(id)
      .then(parseTestResult)
      .catch((e: unknown): TestResult => ({ ok: false, message: reason(e), network: false }))
      .then((result) => {
        setTests((old) => ({ ...old, [id]: { state: 'done', result } }));
      });
  };
  return { tests, run };
}

function TestLine({ id, test }: { readonly id: string; readonly test: Test | undefined }) {
  const { t, format } = useApp();
  if (test === undefined) return null;
  if (test.state === 'running') {
    return (
      <p
        className="provider-test muted small"
        role="status"
        data-testid={`provider-test-result-${id}`}
      >
        {t('providers.testing')}
      </p>
    );
  }
  const { result } = test;
  const ms = format.number(result.latencyMs ?? 0);
  return (
    <p
      className={`provider-test small ${result.ok ? 'is-ok' : 'error-text'}`}
      role={result.ok ? 'status' : 'alert'}
      data-testid={`provider-test-result-${id}`}
      data-ok={result.ok}
    >
      {result.ok
        ? result.model === undefined
          ? t('providers.testOkNoModel', { ms })
          : t('providers.testOk', { model: result.model, ms })
        : t('providers.testFailed', { message: result.message ?? '' })}
      {!result.ok && result.network ? (
        <a
          href="#/settings/proxy"
          className="provider-test-link"
          data-testid={`provider-test-proxy-${id}`}
        >
          {t('login.proxy')}
        </a>
      ) : null}
    </p>
  );
}

function EnabledSwitch({
  id,
  name,
  disabled,
  busy,
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  const t = useT();
  // The choice shows at once; once Core answered (or failed), the saved value rules again.
  const [chosen, setChosen] = useState<boolean>();
  useEffect(() => {
    if (!busy) setChosen(undefined);
  }, [busy, disabled]);
  return (
    <input
      type="checkbox"
      className="preference-switch"
      checked={chosen ?? !disabled}
      aria-busy={chosen !== undefined}
      disabled={busy}
      aria-label={t('providers.enabledNamed', { name })}
      data-testid={`provider-enabled-${id}`}
      onChange={(e) => {
        const enabled = e.currentTarget.checked;
        setChosen(enabled);
        onChange(enabled);
      }}
    />
  );
}

export function ConnectionList({
  settings,
  busy,
  signingIn,
  onEdit,
  onDelete,
  onSetEnabled,
  onSignOut,
  onUseAccount,
  onRemoveAccount,
}: {
  readonly settings: ProviderSettings;
  readonly busy: boolean;
  readonly signingIn: boolean;
  readonly onEdit: (p: Provider) => void;
  readonly onDelete: (id: string) => void;
  readonly onSetEnabled: (id: string, enabled: boolean) => void;
  readonly onSignOut: (p: LoginProvider) => void;
  readonly onUseAccount: (account: Account) => void;
  readonly onRemoveAccount: (account: Account) => void;
}) {
  const t = useT();
  const { tests, run } = useTests();
  const off = new Set(settings.disabled);
  const nameOf = (id: string): string =>
    settings.builtinProviders.find((p) => p.id === id)?.name ?? id;
  const groups = accountsByProvider(settings.accounts);
  const testButton = (id: string) => (
    <Button
      size="small"
      variant="ghost"
      data-testid={`provider-test-${id}`}
      disabled={busy || tests[id]?.state === 'running'}
      onClick={() => {
        run(id);
      }}
    >
      {t('providers.test')}
    </Button>
  );
  const accountRow = (
    login: LoginProvider,
    account: Account,
    several: boolean,
    position: number,
  ) => {
    const id = login.id;
    const isOff = account.active && off.has(id);
    return (
      <li
        key={`account:${id}:${account.id}`}
        className={isOff ? 'is-off' : undefined}
        data-testid={account.active ? `account-${id}` : `account-${id}-${account.id}`}
      >
        <div>
          <div className="provider-name">
            <strong>{login.name}</strong>
            {account.active && several ? (
              <span className="provider-badge">{t('providers.account.inUse')}</span>
            ) : null}
            {account.active && !several ? (
              <span className="provider-badge">
                {login.subscription ? t('providers.signIn.subscription') : t('providers.account')}
              </span>
            ) : null}
            {isOff ? <span className="provider-badge is-muted">{t('providers.off')}</span> : null}
          </div>
          <div className="muted small">
            {account.label ?? (several ? `${login.label} · #${String(position)}` : login.label)}
          </div>
        </div>
        {account.active ? (
          <>
            {testButton(id)}
            <Button
              size="small"
              data-testid={`logout-${id}`}
              disabled={busy || signingIn}
              onClick={() => {
                onSignOut(login);
              }}
            >
              {t('providers.logout')}
            </Button>
            <EnabledSwitch
              id={id}
              name={login.name}
              disabled={isOff}
              busy={busy}
              onChange={(enabled) => {
                onSetEnabled(id, enabled);
              }}
            />
          </>
        ) : (
          <>
            <Button
              size="small"
              data-testid={`account-use-${id}-${account.id}`}
              disabled={busy || signingIn}
              onClick={() => {
                onUseAccount(account);
              }}
            >
              {t('providers.account.use')}
            </Button>
            <Button
              size="small"
              variant="ghost"
              data-testid={`account-remove-${id}-${account.id}`}
              disabled={busy || signingIn}
              onClick={() => {
                onRemoveAccount(account);
              }}
            >
              {t('providers.account.remove')}
            </Button>
          </>
        )}
        {account.active ? <TestLine id={id} test={tests[id]} /> : null}
      </li>
    );
  };
  const providerRow = (p: Provider) => {
    const isOff = off.has(p.id);
    const name = hasEndpoint(p.kind) ? p.id : nameOf(p.id);
    const needsKey = !p.hasCredential && !hasEndpoint(p.kind) && takesKey(makeForm(p));
    const detail = hasEndpoint(p.kind)
      ? `${hostOf(p.baseUrl ?? '')} · ${t('providers.modelCount', { count: p.models?.length ?? 0 })}`
      : t(`providers.${p.kind}`);
    return (
      <li key={p.id} className={isOff ? 'is-off' : undefined} data-testid={`provider-row-${p.id}`}>
        <div>
          <div className="provider-name">
            <strong>{name}</strong>
            {needsKey ? (
              <span className="provider-badge is-warning">{t('providers.needsKey')}</span>
            ) : null}
            {isOff ? <span className="provider-badge is-muted">{t('providers.off')}</span> : null}
          </div>
          <div className="muted small">{detail}</div>
        </div>
        {testButton(p.id)}
        <Button
          size="small"
          data-testid={`provider-edit-${p.id}`}
          disabled={busy}
          onClick={() => {
            onEdit(p);
          }}
        >
          {t('providers.edit')}
        </Button>
        <Button
          variant="destructive"
          size="small"
          data-testid={`provider-delete-${p.id}`}
          disabled={busy}
          onClick={() => {
            onDelete(p.id);
          }}
        >
          {t('providers.remove')}
        </Button>
        <EnabledSwitch
          id={p.id}
          name={name}
          disabled={isOff}
          busy={busy}
          onChange={(enabled) => {
            onSetEnabled(p.id, enabled);
          }}
        />
        <TestLine id={p.id} test={tests[p.id]} />
      </li>
    );
  };
  const accountRows = settings.loginProviders.flatMap((login) => {
    const group = groups.get(login.id) ?? [];
    return group.map((account, index) => accountRow(login, account, group.length > 1, index + 1));
  });
  if (accountRows.length === 0 && settings.providers.length === 0) {
    return <p className="muted settings-connection-empty">{t('providers.empty')}</p>;
  }
  return (
    <ul className="provider-list">
      {accountRows}
      {settings.providers.map(providerRow)}
    </ul>
  );
}
