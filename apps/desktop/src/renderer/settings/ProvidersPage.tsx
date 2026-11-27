import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AliasSection } from './AliasSection.js';
import { ModelSettingsSection } from './ModelSettingsSection.js';
import { WebSearchSection } from './WebSearchSection.js';
import { useSignInDialog } from './SignInSection.js';
import { ServiceChooser, type ServiceChoice } from './ServiceChooser.js';
import { ConnectionList } from './ConnectionList.js';
import { ModelDiscovery } from './ModelDiscovery.js';
import { useT } from '../app/app-context.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { reason } from '../shell/errors.js';
import {
  APIS,
  configOf,
  makeForm,
  fieldErrors,
  hasEndpoint,
  takesKey,
  parseSettings,
  type Account,
  type Auth,
  type Form,
  type LoginProvider,
  type Provider,
  type ProviderSettings,
} from './provider-form.js';
import { Button } from '../app/Button.js';
import { SettingsRow, SettingsSection } from './layout.js';

const AUTH_LABEL: Record<Auth, MessageId> = {
  bearer: 'providers.bearer',
  profile: 'providers.auth.profile',
  apiKey: 'providers.express',
  adc: 'providers.auth.adc',
  serviceAccount: 'providers.auth.serviceAccount',
};
export function ProvidersPage() {
  const t = useT();
  const [settings, setSettings] = useState<ProviderSettings>();
  const [form, setForm] = useState<Form>();
  const [original, setOriginal] = useState<Provider>();
  const [errors, setErrors] = useState<Partial<Record<keyof Form, MessageId>>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  // The catalog refresh choice while Core saves it (I100: the settings Host takes a moment).
  const [refreshing, setRefreshing] = useState<boolean>();
  const [choosing, setChoosing] = useState(false);
  const reload = useCallback((text?: string) => {
    (text === undefined ? window.piarc.providerSettings() : Promise.resolve(text))
      .then(parseSettings)
      .then(setSettings)
      .catch((error: unknown) => {
        setFailure(reason(error));
      });
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  // The account in use of a provider, to say who signed in (ADR-0083).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const accountOf = useCallback(
    (provider: string) =>
      settingsRef.current?.loginProviders.find((l) => l.id === provider && l.signedIn)?.account,
    [],
  );
  const signIn = useSignInDialog(reload, accountOf);
  const edit = (p?: Provider) => {
    setOriginal(p);
    setForm(makeForm(p));
    setErrors({});
    setFailure('');
  };
  const pick = (choice: ServiceChoice) => {
    setChoosing(false);
    setFailure('');
    if (choice.type === 'login') {
      signIn.start(choice.provider, () => window.piarc.startLogin(choice.provider.id));
      return;
    }
    edit();
    setForm({
      ...makeForm(),
      kind: choice.kind,
      id: choice.id,
      auth: choice.id === 'amazon-bedrock' ? 'bearer' : 'apiKey',
    });
  };
  const signOut = (p: LoginProvider) => {
    setFailure('');
    window.piarc.logoutProvider(p.id).then(
      (done) => {
        // Core answers the sign-out itself; read the settings again.
        if (done !== null) reload();
      },
      (e: unknown) => {
        setFailure(reason(e));
      },
    );
  };
  const mutate = async (request: () => Promise<string | null>, close: boolean) => {
    setBusy(true);
    setFailure('');
    try {
      const result = await request();
      if (result !== null) {
        setSettings(parseSettings(result));
        if (close) {
          setForm(undefined);
          setOriginal(undefined);
        }
      }
    } catch (error) {
      const message = reason(error);
      // Electron forwards the Error message only; Core prefixes field errors with the
      // validated field name. Keep the explanation and mark the corresponding control.
      const field = /^invalid (\w+):/u.exec(message)?.[1];
      if (form && field && Object.hasOwn(form, field)) {
        setErrors((previous) => ({ ...previous, [field]: 'providers.error.invalid' }));
      }
      setFailure(message);
    } finally {
      setBusy(false);
    }
  };
  const change = <K extends keyof Form>(key: K, value: Form[K]) => {
    if (form !== undefined) setForm({ ...form, [key]: value });
    setErrors((old) => ({ ...old, [key]: undefined }));
  };
  const field = (key: keyof Form, label: MessageId, component: ReactNode) => (
    <div className="setting">
      <label htmlFor={`provider-${key}`} className="setting-label">
        {t(label)}
      </label>
      {component}
      {errors[key] && (
        <span className="error-text small" id={`error-${key}`} role="alert">
          {t(errors[key])}
        </span>
      )}
    </div>
  );
  const props = (key: keyof Form) => ({
    id: `provider-${key}`,
    className: 'input',
    'data-testid': `provider-${key === 'baseUrl' ? 'url' : key}`,
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': errors[key] ? `error-${key}` : undefined,
  });
  const input = (
    key: 'baseUrl' | 'region' | 'project' | 'profile' | 'credentialPath',
    label: MessageId,
  ) =>
    field(
      key,
      label,
      <input
        {...props(key)}
        value={form?.[key] ?? ''}
        onChange={(e) => {
          change(key, e.currentTarget.value);
        }}
      />,
    );
  const failed = failure && (
    <p className="error-text" role="alert">
      {t('providers.failed', { reason: failure })}
    </p>
  );
  if (!settings)
    return (
      failed || (
        <p className="muted" role="status">
          {t('providers.loading')}
        </p>
      )
    );
  const endpoint = form && hasEndpoint(form.kind);
  const nameOf = (id: string): string =>
    settings.builtinProviders.find((p) => p.id === id)?.name ?? id;
  const header = (
    <SettingsRow
      label={t('providers.refresh')}
      htmlFor="provider-catalog-refresh"
      description={
        refreshing === undefined ? undefined : (
          <span role="status" data-testid="catalog-refresh-saving">
            {t('providers.refreshing')}
          </span>
        )
      }
    >
      <input
        id="provider-catalog-refresh"
        type="checkbox"
        className="preference-switch"
        data-testid="catalog-refresh"
        checked={refreshing ?? settings.catalogRefresh}
        disabled={busy}
        aria-busy={refreshing !== undefined}
        onChange={(e) => {
          const enabled = e.currentTarget.checked;
          setRefreshing(enabled);
          void mutate(() => window.piarc.setCatalogRefresh(enabled), false).finally(() => {
            setRefreshing(undefined);
          });
        }}
      />
    </SettingsRow>
  );
  const useAccount = (account: Account) => {
    void mutate(() => window.piarc.useProviderAccount(account.provider, account.id), false);
  };
  const removeAccount = (account: Account) => {
    void mutate(() => window.piarc.removeProviderAccount(account.provider, account.id), false);
  };
  if (!form)
    return (
      <div className="settings-section settings-detail-page">
        <SettingsSection
          title={t('providers.connections')}
          testId="provider-connections"
          aside={
            <Button
              size="small"
              variant="primary"
              data-testid="provider-add"
              disabled={busy || signIn.open}
              onClick={() => {
                setChoosing(true);
              }}
            >
              {t('providers.add')}
            </Button>
          }
        >
          <ConnectionList
            settings={settings}
            busy={busy}
            signingIn={signIn.open}
            onEdit={edit}
            onDelete={(id) => {
              void mutate(() => window.piarc.deleteProvider(id), false);
            }}
            onSetEnabled={(id, enabled) => {
              void mutate(() => window.piarc.setProviderEnabled(id, enabled), false);
            }}
            onSignOut={signOut}
            onUseAccount={useAccount}
            onRemoveAccount={removeAccount}
          />
        </SettingsSection>
        {failed}
        {signIn.failure === '' ? null : (
          <p className="error-text" role="alert">
            {t('providers.failed', { reason: signIn.failure })}
          </p>
        )}
        <ModelSettingsSection
          catalogRow={header}
          settings={settings}
          busy={busy}
          save={(preferences) => {
            void mutate(() => window.piarc.setModelPreferences(preferences), false);
          }}
        />
        <AliasSection
          settings={settings}
          busy={busy}
          save={(preferences) => {
            void mutate(() => window.piarc.setModelPreferences(preferences), false);
          }}
        />
        <WebSearchSection settings={settings} />
        {choosing ? (
          <ServiceChooser
            settings={settings}
            onPick={pick}
            onCancel={() => {
              setChoosing(false);
            }}
          />
        ) : null}
        {signIn.dialog}
      </div>
    );
  const authChoices: Auth[] =
    form.id === 'amazon-bedrock' ? ['bearer', 'profile'] : ['apiKey', 'adc', 'serviceAccount'];
  const formName = endpoint ? t(`providers.${form.kind}`) : nameOf(form.id);
  return (
    <form
      className="settings-section settings-detail-page"
      autoComplete="off"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const invalid = fieldErrors(form, settings, original);
        setErrors(invalid);
        if (Object.keys(invalid).length > 0) return;
        const secret = form.removeKey
          ? { key: '' }
          : form.key && takesKey(form)
            ? { key: form.key }
            : undefined;
        void mutate(
          () =>
            window.piarc.saveProvider(
              JSON.stringify(configOf(form)),
              secret && JSON.stringify(secret),
            ),
          true,
        );
      }}
    >
      <div className="provider-form-head">
        <h2 className="settings-heading" data-testid="provider-form-title">
          {original ? formName : t('providers.addNamed', { name: formName })}
        </h2>
        {endpoint ? null : <span className="muted small">{t(`providers.${form.kind}`)}</span>}
      </div>
      <fieldset className="settings-section provider-form" disabled={busy}>
        {endpoint
          ? field(
              'id',
              'providers.id',
              <input
                {...props('id')}
                disabled={Boolean(original)}
                value={form.id}
                onChange={(e) => {
                  change('id', e.currentTarget.value);
                }}
              />,
            )
          : null}
        {endpoint && (
          <>
            {field(
              'api',
              'providers.api',
              <select
                {...props('api')}
                value={form.api}
                onChange={(e) => {
                  change('api', e.currentTarget.value as Form['api']);
                }}
              >
                {APIS.map((api) => (
                  <option value={api} key={api}>
                    {t(`providers.api.${api}`)}
                  </option>
                ))}
              </select>,
            )}
            {input('baseUrl', 'providers.url')}
            {field(
              'models',
              'providers.models',
              <textarea
                {...props('models')}
                rows={3}
                value={form.models}
                onChange={(e) => {
                  change('models', e.currentTarget.value);
                }}
              />,
            )}
            <ModelDiscovery
              form={form}
              savedId={original?.id}
              disabled={busy}
              onModels={(models) => {
                change('models', models);
              }}
            />
          </>
        )}
        {form.kind === 'cloud' && (
          <>
            {field(
              'auth',
              'providers.auth',
              <select
                {...props('auth')}
                value={form.auth}
                onChange={(e) => {
                  setForm({
                    ...form,
                    auth: e.currentTarget.value as Auth,
                    key: '',
                    removeKey: false,
                  });
                  setErrors({});
                }}
              >
                {authChoices.map((auth) => (
                  <option value={auth} key={auth}>
                    {t(AUTH_LABEL[auth])}
                  </option>
                ))}
              </select>,
            )}
            {form.auth !== 'apiKey' && input('region', 'providers.region')}
            {(form.auth === 'adc' || form.auth === 'serviceAccount') &&
              input('project', 'providers.project')}
            {form.auth === 'profile' && input('profile', 'providers.profile')}
            {form.auth === 'serviceAccount' && input('credentialPath', 'providers.path')}
          </>
        )}
        {takesKey(form) && (
          <>
            {field(
              'key',
              form.kind === 'cloud'
                ? AUTH_LABEL[form.auth]
                : endpoint
                  ? 'providers.keyOptional'
                  : 'providers.key',
              <input
                {...props('key')}
                type="password"
                autoComplete="new-password"
                disabled={form.removeKey}
                value={form.key}
                onChange={(e) => {
                  change('key', e.currentTarget.value);
                }}
              />,
            )}
            {original?.hasCredential && takesKey(makeForm(original)) && (
              <>
                <span className="muted small">{t('providers.keepKey')}</span>
                {endpoint && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={form.removeKey}
                      onChange={(e) => {
                        setForm({ ...form, key: '', removeKey: e.currentTarget.checked });
                        setErrors({});
                      }}
                    />
                    {t('providers.clearKey')}
                  </label>
                )}
              </>
            )}
          </>
        )}
        {failed}
        <div className="dialog-actions">
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              setForm(undefined);
              setFailure('');
            }}
          >
            {t('dialog.cancel')}
          </Button>
          <Button type="submit" variant="primary" data-testid="provider-save">
            {t('providers.save')}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
