import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AliasSection } from './AliasSection.js';
import { ModelSettingsSection } from './ModelSettingsSection.js';
import { SignInSection } from './SignInSection.js';
import { useT } from '../app/app-context.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { reason } from '../shell/errors.js';
import {
  APIS,
  KINDS,
  configOf,
  makeForm,
  fieldErrors,
  hasEndpoint,
  takesKey,
  parseSettings,
  type Auth,
  type Form,
  type Kind,
  type Provider,
  type ProviderSettings,
} from './provider-form.js';

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
  const edit = (p?: Provider) => {
    setOriginal(p);
    setForm(makeForm(p));
    setErrors({});
    setFailure('');
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
  const cloudIds = ['amazon-bedrock', 'google-vertex'];
  const endpoint = form && hasEndpoint(form.kind);
  const header = (
    <label className="checkbox">
      <input
        type="checkbox"
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
      {t('providers.refresh')}
      {refreshing === undefined ? null : (
        <span className="muted small" role="status" data-testid="catalog-refresh-saving">
          {t('providers.refreshing')}
        </span>
      )}
    </label>
  );
  if (!form)
    return (
      <div className="settings-section">
        {header}
        {settings.providers.length === 0 ? (
          <p className="muted">{t('providers.empty')}</p>
        ) : (
          <ul className="provider-list">
            {settings.providers.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.id}</strong>
                  <div className="muted small">{p.baseUrl ?? t(`providers.${p.kind}`)}</div>
                </div>
                <button
                  type="button"
                  className="button"
                  data-testid={`provider-edit-${p.id}`}
                  disabled={busy}
                  onClick={() => {
                    edit(p);
                  }}
                >
                  {t('providers.edit')}
                </button>
                <button
                  type="button"
                  className="button"
                  data-testid={`provider-delete-${p.id}`}
                  disabled={busy}
                  onClick={() => {
                    void mutate(() => window.piarc.deleteProvider(p.id), false);
                  }}
                >
                  {t('providers.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button
            type="button"
            className="button button-primary"
            data-testid="provider-add"
            disabled={busy}
            onClick={() => {
              edit();
            }}
          >
            {t('providers.add')}
          </button>
        </div>
        {failed}
        <SignInSection providers={settings.loginProviders} busy={busy} onChanged={reload} />
        <ModelSettingsSection
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
      </div>
    );
  const selectedProviders = settings.builtinProviders.filter((p) =>
    form.kind === 'cloud' ? cloudIds.includes(p.id) : !cloudIds.includes(p.id),
  );
  const authChoices: Auth[] =
    form.id === 'amazon-bedrock' ? ['bearer', 'profile'] : ['apiKey', 'adc', 'serviceAccount'];
  return (
    <form
      className="settings-section"
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
      <fieldset className="settings-section provider-form" disabled={busy}>
        {field(
          'kind',
          'providers.kind',
          <select
            {...props('kind')}
            value={form.kind}
            disabled={original !== undefined}
            onChange={(e) => {
              const kind = e.currentTarget.value as Kind;
              const id =
                kind === 'cloud'
                  ? 'amazon-bedrock'
                  : kind === 'builtin'
                    ? (settings.builtinProviders.find((p) => !cloudIds.includes(p.id))?.id ?? '')
                    : '';
              setForm({
                ...makeForm(),
                kind,
                id,
                auth: id === 'amazon-bedrock' ? 'bearer' : 'apiKey',
              });
              setErrors({});
            }}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`providers.${kind}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'id',
          'providers.id',
          endpoint ? (
            <input
              {...props('id')}
              disabled={Boolean(original)}
              value={form.id}
              onChange={(e) => {
                change('id', e.currentTarget.value);
              }}
            />
          ) : (
            <select
              {...props('id')}
              disabled={Boolean(original)}
              value={form.id}
              onChange={(e) => {
                const id = e.currentTarget.value;
                setForm({
                  ...form,
                  id,
                  auth: id === 'amazon-bedrock' ? 'bearer' : 'apiKey',
                  key: '',
                });
                setErrors({});
              }}
            >
              {selectedProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ),
        )}
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
          <button
            type="button"
            className="button"
            onClick={() => {
              setForm(undefined);
              setFailure('');
            }}
          >
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="button button-primary" data-testid="provider-save">
            {t('providers.save')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
