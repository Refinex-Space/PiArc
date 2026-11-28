// "Connect a model", the first-run guide's second step (ADR-0110): quick-setup tiles on the
// left (provider families, sign-in, custom and local endpoints), the chosen one's form on the
// right. "Test and continue" saves through the same `saveProvider` as Settings, then asks Core
// to send one tiny request (`testProvider`). The key lives only in this component's state and
// is dropped whenever the choice, the variant or the endpoint changes.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useApp, useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { ServiceChooser, type ServiceChoice } from '../settings/ServiceChooser.js';
import { useSignInDialog } from '../settings/SignInSection.js';
import {
  APIS,
  configOf,
  fieldErrors,
  makeForm,
  parseDiscovered,
  parseSettings,
  parseTestResult,
  type Form,
  type LoginProvider,
  type ProviderSettings,
} from '../settings/provider-form.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { reason } from '../shell/errors.js';
import { ChevronRightIcon, ExternalGlyph, ProviderMark } from '../shell/icons.js';
import { ChoiceButton } from '../shell/Menu.js';
import { endpointId, hostOf, LOCAL_BASE_URL } from './endpoint.js';
import {
  availableFamilies,
  defaultVariant,
  familyConnected,
  isConnected,
  type FamilyId,
} from './families.js';
import { keyPageOf } from './key-links.js';

type Choice =
  | { readonly kind: 'family'; readonly family: FamilyId }
  /** A built-in provider picked from "More providers". */
  | { readonly kind: 'builtin'; readonly id: string }
  | { readonly kind: 'login' }
  | { readonly kind: 'custom' }
  | { readonly kind: 'local' };

type Outcome =
  | { readonly state: 'idle' }
  | { readonly state: 'busy' }
  | {
      readonly state: 'ok';
      readonly name: string;
      readonly mark: string;
      readonly model?: string;
      readonly latencyMs?: number;
      readonly account?: string;
    }
  | { readonly state: 'failed'; readonly message: string; readonly network: boolean };

interface Endpoint {
  readonly api: Form['api'];
  readonly baseUrl: string;
  readonly model: string;
  readonly id: string;
  /** The user typed an id under "Advanced"; it no longer follows the address. */
  readonly idEdited: boolean;
}

type FieldErrors = Partial<Record<'key' | 'baseUrl' | 'models' | 'id', MessageId | undefined>>;

const FAMILY_NAME: Record<FamilyId, MessageId> = {
  deepseek: 'onboarding.family.deepseek',
  glm: 'onboarding.family.glm',
  kimi: 'onboarding.family.kimi',
  qwen: 'onboarding.family.qwen',
  minimax: 'onboarding.family.minimax',
  mimo: 'onboarding.family.mimo',
  openai: 'onboarding.family.openai',
  anthropic: 'onboarding.family.anthropic',
  gemini: 'onboarding.family.gemini',
  openrouter: 'onboarding.family.openrouter',
};

function sameChoice(a: Choice, b: Choice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'family' && b.kind === 'family') return a.family === b.family;
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.id === b.id;
  return true;
}

function choiceKey(choice: Choice): string {
  return choice.kind === 'family'
    ? `family-${choice.family}`
    : choice.kind === 'builtin'
      ? `builtin-${choice.id}`
      : choice.kind;
}

export function ConnectModel({
  onBack,
  onDone,
  backLabel,
}: {
  readonly onBack: () => void;
  readonly onDone: () => void;
  readonly backLabel: MessageId;
}) {
  const t = useT();
  const { locale, platform } = useApp();
  const titleId = useId();
  const keyId = useId();
  const [settings, setSettings] = useState<ProviderSettings>();
  const [loadFailure, setLoadFailure] = useState('');
  const [choice, setChoice] = useState<Choice>();
  const [variants, setVariants] = useState<Partial<Record<FamilyId, string>>>({});
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState<Endpoint>({
    api: 'openai-completions',
    baseUrl: '',
    model: '',
    id: '',
    idEdited: false,
  });
  const [advanced, setAdvanced] = useState(false);
  /** The endpoint id this guide saved: a retry saves over it instead of adding another. */
  const [savedEndpoint, setSavedEndpoint] = useState<string>();
  const [found, setFound] = useState<string[]>();
  const [discovering, setDiscovering] = useState(false);
  const [discoverFailure, setDiscoverFailure] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const [choosing, setChoosing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  // A late answer to an attempt the user left (Back, another tile) changes nothing.
  const attempt = useRef(0);
  const signingIn = useRef<LoginProvider | undefined>(undefined);

  useEffect(() => {
    heading.current?.focus();
  }, []);
  // A failed test hands the key field back (enabled again by this render) to fix and retry.
  const failedNow = outcome.state === 'failed';
  useEffect(() => {
    if (failedNow) keyInput.current?.focus();
  }, [failedNow]);
  const load = useCallback(
    () =>
      window.piarc
        .providerSettings()
        .then(parseSettings)
        .then((next) => {
          setSettings(next);
          return next;
        }),
    [],
  );
  useEffect(() => {
    load().catch((e: unknown) => {
      setLoadFailure(reason(e));
    });
  }, [load]);
  // The key never outlives this step.
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const families = useMemo(
    () =>
      settings === undefined
        ? []
        : availableFamilies(
            settings.builtinProviders.map((p) => p.id),
            locale,
          ),
    [settings, locale],
  );
  const current: Choice | undefined =
    choice ??
    (families[0] === undefined
      ? settings === undefined
        ? undefined
        : { kind: 'custom' }
      : { kind: 'family', family: families[0].id });

  const accountOf = useCallback(
    (provider: string) => settings?.loginProviders.find((l) => l.id === provider)?.account,
    [settings],
  );
  const signIn = useSignInDialog(() => {
    const provider = signingIn.current;
    const mine = attempt.current;
    load()
      .then((next) => {
        const login = next.loginProviders.find((p) => p.id === provider?.id);
        if (mine !== attempt.current || login?.signedIn !== true) return;
        setOutcome({
          state: 'ok',
          name: login.name,
          mark: login.id,
          ...(login.account === undefined ? {} : { account: login.account }),
        });
      })
      .catch((e: unknown) => {
        setLoadFailure(reason(e));
      });
  }, accountOf);
  const startSignIn = (provider: LoginProvider) => {
    attempt.current += 1;
    signingIn.current = provider;
    setOutcome({ state: 'idle' });
    signIn.start(provider, () => window.piarc.startLogin(provider.id));
  };

  /** Everything typed for the previous target goes: the key first. */
  const reset = () => {
    attempt.current += 1;
    setKey('');
    setErrors({});
    setOutcome({ state: 'idle' });
    setFound(undefined);
    setDiscoverFailure('');
  };
  const pick = (next: Choice) => {
    if (current !== undefined && sameChoice(current, next)) return;
    reset();
    setAdvanced(false);
    setSavedEndpoint(undefined);
    if (next.kind === 'custom' || next.kind === 'local') {
      const baseUrl = next.kind === 'local' ? LOCAL_BASE_URL : '';
      setEndpoint({ api: 'openai-completions', baseUrl, model: '', id: '', idEdited: false });
    }
    setChoice(next);
  };

  if (settings === undefined || current === undefined) {
    return (
      <section className="onboarding-connect" aria-labelledby={titleId}>
        <h1 id={titleId} ref={heading} tabIndex={-1} data-focus-proxy className="onboarding-title">
          {t('onboarding.connect.title')}
        </h1>
        {loadFailure === '' ? (
          <p className="onboarding-loading muted" role="status">
            {t('providers.loading')}
          </p>
        ) : (
          <p className="error-text" role="alert">
            {t('providers.failed', { reason: loadFailure })}
          </p>
        )}
        <div className="onboarding-actions">
          <Button variant="ghost" data-testid="onboarding-back" onClick={onBack}>
            {t(backLabel)}
          </Button>
        </div>
      </section>
    );
  }

  const builtinName = (id: string) =>
    settings.builtinProviders.find((p) => p.id === id)?.name ?? id;
  const family =
    current.kind === 'family' ? families.find((f) => f.id === current.family) : undefined;
  /** The built-in provider a key goes to, for a family or a "More providers" pick. */
  const target =
    family !== undefined
      ? (
          family.variants.find((v) => v.id === variants[family.id]) ??
          defaultVariant(family, locale)
        )?.id
      : current.kind === 'builtin'
        ? current.id
        : undefined;
  const isEndpoint = current.kind === 'custom' || current.kind === 'local';
  const connected = target !== undefined && isConnected(settings, target);
  const busy = outcome.state === 'busy';
  const done = outcome.state === 'ok';
  const familyLogin =
    family?.login === undefined
      ? undefined
      : settings.loginProviders.find((p) => p.id === family.login);
  const targetName =
    family !== undefined
      ? t(FAMILY_NAME[family.id])
      : target !== undefined
        ? builtinName(target)
        : '';
  const taken = new Set([
    ...settings.providers.map((p) => p.id),
    ...settings.builtinProviders.map((p) => p.id),
  ]);
  const endpointIdNow =
    endpoint.idEdited || !isEndpoint
      ? endpoint.id
      : (savedEndpoint ?? endpointId(current.kind, endpoint.baseUrl, taken));

  const changeEndpoint = (patch: Partial<Endpoint>) => {
    // A new address or protocol is a new destination: the key typed for the old one goes.
    if (
      (patch.baseUrl !== undefined && patch.baseUrl !== endpoint.baseUrl) ||
      (patch.api !== undefined && patch.api !== endpoint.api)
    ) {
      reset();
    } else {
      setErrors((old) => ({
        ...old,
        ...(patch.model === undefined ? {} : { models: undefined }),
        ...(patch.id === undefined ? {} : { id: undefined }),
      }));
    }
    setEndpoint((old) => ({ ...old, ...patch }));
  };

  const test = async (provider: string, name: string, mark: string, mine: number) => {
    const result = parseTestResult(await window.piarc.testProvider(provider));
    if (mine !== attempt.current) return;
    if (result.ok) {
      setOutcome({
        state: 'ok',
        name,
        mark,
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      });
      setKey('');
    } else {
      setOutcome({
        state: 'failed',
        message: result.message ?? t('onboarding.connect.noAnswer'),
        network: result.network,
      });
    }
  };

  const submit = () => {
    if (busy) return;
    if (done) {
      onDone();
      return;
    }
    let form: Form;
    let name: string;
    let mark: string;
    if (target !== undefined) {
      form = { ...makeForm(), kind: 'builtin', id: target, key, auth: 'apiKey' };
      name = targetName;
      mark = target;
    } else if (isEndpoint) {
      form = {
        ...makeForm(),
        kind: current.kind,
        id: endpointIdNow,
        api: endpoint.api,
        baseUrl: endpoint.baseUrl.trim(),
        models: endpoint.model.trim(),
        key,
      };
      name = endpointIdNow;
      mark = endpointIdNow;
    } else {
      return;
    }
    const original = settings.providers.find((p) => p.id === form.id);
    // An endpoint saved by an earlier attempt here is edited; any other id must be new.
    const editing = target !== undefined || form.id === savedEndpoint ? original : undefined;
    const invalid = fieldErrors(form, settings, editing);
    const shown: FieldErrors = {
      ...(invalid.key === undefined ? {} : { key: invalid.key }),
      ...(invalid.baseUrl === undefined ? {} : { baseUrl: invalid.baseUrl }),
      ...(invalid.models === undefined ? {} : { models: invalid.models }),
      ...(invalid.id === undefined ? {} : { id: invalid.id }),
    };
    setErrors(shown);
    if (Object.keys(shown).length > 0) {
      if (shown.id !== undefined) setAdvanced(true);
      return;
    }
    attempt.current += 1;
    const mine = attempt.current;
    setOutcome({ state: 'busy' });
    const save =
      key === '' && target !== undefined && connected
        ? Promise.resolve()
        : window.piarc
            .saveProvider(
              JSON.stringify(configOf(form)),
              key === '' ? undefined : JSON.stringify({ key }),
            )
            .then((text) => {
              if (mine !== attempt.current) return;
              setSettings(parseSettings(text));
              if (isEndpoint) setSavedEndpoint(form.id);
            });
    save
      .then(() => (mine === attempt.current ? test(form.id, name, mark, mine) : undefined))
      .catch((e: unknown) => {
        if (mine !== attempt.current) return;
        setOutcome({ state: 'failed', message: reason(e), network: false });
      });
  };

  const discover = () => {
    setDiscovering(true);
    setDiscoverFailure('');
    window.piarc
      .discoverModels(
        JSON.stringify({ api: endpoint.api, baseUrl: endpoint.baseUrl.trim() }),
        key === '' ? undefined : JSON.stringify({ key }),
      )
      .then(parseDiscovered)
      .then((models) => {
        setFound(models);
        if (endpoint.model === '' && models[0] !== undefined) changeEndpoint({ model: models[0] });
      })
      .catch((e: unknown) => {
        setFound(undefined);
        setDiscoverFailure(reason(e));
      })
      .finally(() => {
        setDiscovering(false);
      });
  };

  const tiles: { readonly choice: Choice; readonly node: ReactNode; readonly on: boolean }[] = [
    ...families.map((f) => ({
      choice: { kind: 'family', family: f.id } as const,
      on: familyConnected(settings, f),
      node: (
        <Tile
          mark={<ProviderMark provider={{ id: f.mark }} size={20} />}
          name={t(FAMILY_NAME[f.id])}
          detail={t(`onboarding.family.${f.id}.detail`)}
          connected={familyConnected(settings, f)}
        />
      ),
    })),
    ...(settings.loginProviders.length > 0
      ? [
          {
            choice: { kind: 'login' } as const,
            on: settings.loginProviders.some((p) => p.signedIn),
            node: (
              <Tile
                mark={<ProviderMark provider={{ id: 'openai-codex' }} size={20} />}
                name={t('onboarding.tile.login')}
                detail={t('onboarding.tile.loginDetail')}
                connected={false}
              />
            ),
          },
        ]
      : []),
    ...(current.kind === 'builtin'
      ? [
          {
            choice: current,
            on: connected,
            node: (
              <Tile
                mark={<ProviderMark provider={{ id: current.id }} size={20} />}
                name={builtinName(current.id)}
                detail={t('onboarding.tile.apiKey')}
                connected={connected}
              />
            ),
          },
        ]
      : []),
    ...(['custom', 'local'] as const).map((kind) => ({
      choice: { kind } as const,
      on: false,
      node: (
        <Tile
          mark={<ProviderMark provider={{ id: kind }} local={kind === 'local'} size={20} />}
          name={t(`onboarding.tile.${kind}`)}
          detail={t(`onboarding.tile.${kind}Detail`)}
          connected={false}
        />
      ),
    })),
  ];

  const moveSelection = (step: number) => {
    const index = tiles.findIndex((tile) => sameChoice(tile.choice, current));
    const next = tiles[(index + step + tiles.length) % tiles.length];
    if (next === undefined) return;
    pick(next.choice);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="onboarding-tile-${choiceKey(next.choice)}"]`)
        ?.focus();
    });
  };

  const field = (
    id: string,
    label: string,
    control: ReactNode,
    error: MessageId | undefined,
    aside?: ReactNode,
  ) => (
    <div className="onboarding-field" data-invalid={error === undefined ? undefined : true}>
      <div className="onboarding-field-head">
        <label htmlFor={id} className="onboarding-label">
          {label}
        </label>
        {aside}
      </div>
      <div className="onboarding-input">{control}</div>
      {error === undefined ? null : (
        <span className="error-text small" id={`${id}-error`} role="alert">
          {t(error)}
        </span>
      )}
    </div>
  );
  const input = (
    id: string,
    value: string,
    onChange: (value: string) => void,
    error: MessageId | undefined,
    extra: { placeholder?: string; type?: string; testId: string; mono?: boolean } = {
      testId: id,
    },
  ) => (
    <input
      id={id}
      data-focus-proxy
      data-testid={extra.testId}
      className={extra.mono === true ? 'onboarding-mono' : undefined}
      type={extra.type ?? 'text'}
      spellCheck={false}
      autoComplete={extra.type === 'password' ? 'new-password' : 'off'}
      placeholder={extra.placeholder}
      value={value}
      disabled={busy || done}
      aria-invalid={error !== undefined}
      aria-describedby={error === undefined ? undefined : `${id}-error`}
      onChange={(e) => {
        onChange(e.currentTarget.value);
      }}
    />
  );
  const keyField = (optional: boolean) => {
    const page = target === undefined ? undefined : keyPageOf(target);
    return field(
      keyId,
      t(optional ? 'onboarding.field.keyOptional' : 'onboarding.field.key'),
      <input
        id={keyId}
        ref={keyInput}
        data-focus-proxy
        data-testid="onboarding-key"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        placeholder={t(connected ? 'onboarding.field.keyKept' : 'onboarding.field.keyPlaceholder')}
        value={key}
        disabled={busy || done}
        aria-invalid={errors.key !== undefined}
        aria-describedby={errors.key === undefined ? undefined : `${keyId}-error`}
        onChange={(e) => {
          setKey(e.currentTarget.value);
          setErrors((old) => ({ ...old, key: undefined }));
          if (outcome.state === 'failed') setOutcome({ state: 'idle' });
        }}
      />,
      errors.key,
      page === undefined ? undefined : (
        <button
          type="button"
          className="onboarding-link"
          data-testid="onboarding-get-key"
          onClick={() => {
            void window.piarc.openExternal(page);
          }}
        >
          {t('onboarding.field.getKey')}
          <ExternalGlyph size={12} />
        </button>
      ),
    );
  };

  const primaryLabel: MessageId = done
    ? 'onboarding.connect.start'
    : connected && key === ''
      ? 'onboarding.connect.test'
      : connected
        ? 'onboarding.connect.replace'
        : 'onboarding.connect.submit';
  const host = isEndpoint ? hostOf(endpoint.baseUrl) : undefined;
  const note: string | undefined =
    current.kind === 'login'
      ? undefined
      : t(platform === 'darwin' ? 'onboarding.connect.noteMac' : 'onboarding.connect.notePc', {
          name: isEndpoint ? (host ?? t('onboarding.connect.thisEndpoint')) : targetName,
        });

  return (
    <section className="onboarding-connect" aria-labelledby={titleId}>
      <h1 id={titleId} ref={heading} tabIndex={-1} data-focus-proxy className="onboarding-title">
        {t('onboarding.connect.title')}
      </h1>
      <p className="onboarding-subtitle">{t('onboarding.connect.lede')}</p>
      <div className="onboarding-card" data-testid="onboarding-card">
        <div className="onboarding-picker">
          <h2 className="onboarding-section-label" id={`${titleId}-quick`}>
            {t('onboarding.connect.quick')}
          </h2>
          <div
            role="radiogroup"
            aria-labelledby={`${titleId}-quick`}
            className="onboarding-tiles"
            onKeyDown={(e) => {
              const step =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (step === 0 || busy) return;
              e.preventDefault();
              moveSelection(step);
            }}
          >
            {tiles.map((tile) => {
              const selected = sameChoice(tile.choice, current);
              return (
                <button
                  key={choiceKey(tile.choice)}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  className="onboarding-tile"
                  data-testid={`onboarding-tile-${choiceKey(tile.choice)}`}
                  data-connected={tile.on ? true : undefined}
                  disabled={busy}
                  onClick={() => {
                    pick(tile.choice);
                  }}
                >
                  {tile.node}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="onboarding-more"
            data-testid="onboarding-more"
            disabled={busy}
            onClick={() => {
              setChoosing(true);
            }}
          >
            {t('onboarding.connect.more')}
            <ChevronRightIcon size={12} />
          </button>
        </div>
        <form
          className="onboarding-form"
          autoComplete="off"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="onboarding-form-body" key={choiceKey(current)}>
            <div className="onboarding-form-head">
              <span className="onboarding-form-mark" aria-hidden="true">
                {current.kind === 'login' ? (
                  <ProviderMark provider={{ id: 'openai-codex' }} size={20} />
                ) : (
                  <ProviderMark
                    provider={{ id: family?.mark ?? target ?? current.kind }}
                    local={current.kind === 'local'}
                    size={20}
                  />
                )}
              </span>
              <h2 className="onboarding-form-title" data-testid="onboarding-form-title">
                {current.kind === 'login'
                  ? t('onboarding.tile.login')
                  : isEndpoint
                    ? t(`providers.${current.kind}`)
                    : targetName}
              </h2>
              {family !== undefined && family.variants.length > 1 && target !== undefined ? (
                <ChoiceButton
                  label={t('onboarding.field.variant')}
                  valueLabel={t(`onboarding.variant.${target}` as MessageId)}
                  testId="onboarding-variant"
                  className="onboarding-variant"
                  disabled={busy || done}
                  above={false}
                  items={family.variants.map((v) => ({
                    id: v.id,
                    label: t(`onboarding.variant.${v.id}` as MessageId),
                    selected: v.id === target,
                    testId: `onboarding-variant-${v.id}`,
                    ...(isConnected(settings, v.id)
                      ? { hint: t('onboarding.tile.connected') }
                      : {}),
                    run: () => {
                      if (v.id === target) return;
                      reset();
                      setVariants((old) => ({ ...old, [family.id]: v.id }));
                    },
                  }))}
                >
                  {t(`onboarding.variant.${target}` as MessageId)}
                </ChoiceButton>
              ) : null}
            </div>
            {current.kind === 'login' ? (
              <LoginList
                providers={settings.loginProviders}
                disabled={busy || signIn.open}
                onPick={startSignIn}
              />
            ) : isEndpoint ? (
              <>
                <div className="onboarding-field">
                  <span className="onboarding-label" id={`${titleId}-api`}>
                    {t('providers.api')}
                  </span>
                  <ChoiceButton
                    label={t('providers.api')}
                    valueLabel={t(`providers.api.${endpoint.api}`)}
                    testId="onboarding-api"
                    className="onboarding-select"
                    disabled={busy || done}
                    above={false}
                    items={APIS.map((api) => ({
                      id: api,
                      label: t(`providers.api.${api}`),
                      selected: api === endpoint.api,
                      run: () => {
                        changeEndpoint({ api });
                      },
                    }))}
                  >
                    {t(`providers.api.${endpoint.api}`)}
                  </ChoiceButton>
                </div>
                {field(
                  `${titleId}-url`,
                  t('onboarding.field.baseUrl'),
                  input(
                    `${titleId}-url`,
                    endpoint.baseUrl,
                    (value) => {
                      changeEndpoint({ baseUrl: value });
                    },
                    errors.baseUrl,
                    { testId: 'onboarding-url', placeholder: 'https://', mono: true },
                  ),
                  errors.baseUrl,
                )}
                {keyField(true)}
                {field(
                  `${titleId}-model`,
                  t('onboarding.field.model'),
                  input(
                    `${titleId}-model`,
                    endpoint.model,
                    (value) => {
                      changeEndpoint({ model: value });
                    },
                    errors.models,
                    { testId: 'onboarding-model', mono: true },
                  ),
                  errors.models,
                  <button
                    type="button"
                    className="onboarding-link"
                    data-testid="onboarding-discover"
                    disabled={busy || done || discovering || endpoint.baseUrl.trim() === ''}
                    aria-busy={discovering}
                    onClick={discover}
                  >
                    {t(discovering ? 'onboarding.field.discovering' : 'onboarding.field.discover')}
                  </button>,
                )}
                {discoverFailure === '' ? null : (
                  <p
                    className="error-text small"
                    role="alert"
                    data-testid="onboarding-discover-failed"
                  >
                    {t('providers.discoverFailed', { reason: discoverFailure })}
                  </p>
                )}
                {found === undefined ? null : found.length === 0 ? (
                  <p className="muted small" role="status">
                    {t('providers.discoverNone')}
                  </p>
                ) : (
                  <div
                    className="onboarding-chips"
                    role="listbox"
                    aria-label={t('providers.discovered')}
                  >
                    {found.slice(0, 40).map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={id === endpoint.model}
                        className="onboarding-chip"
                        data-testid={`onboarding-chip-${id}`}
                        disabled={busy || done}
                        onClick={() => {
                          changeEndpoint({ model: id });
                        }}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="onboarding-disclosure"
                  aria-expanded={advanced}
                  data-testid="onboarding-advanced"
                  onClick={() => {
                    setAdvanced((open) => !open);
                  }}
                >
                  <ChevronRightIcon size={12} />
                  {t('onboarding.field.advanced')}
                </button>
                {advanced
                  ? field(
                      `${titleId}-id`,
                      t('providers.id'),
                      input(
                        `${titleId}-id`,
                        endpointIdNow,
                        (value) => {
                          changeEndpoint({ id: value, idEdited: true });
                        },
                        errors.id,
                        { testId: 'onboarding-id', mono: true },
                      ),
                      errors.id,
                    )
                  : null}
              </>
            ) : (
              <>
                {keyField(false)}
                {familyLogin === undefined ? null : (
                  <button
                    type="button"
                    className="onboarding-link onboarding-alt"
                    data-testid="onboarding-family-login"
                    disabled={busy || done || signIn.open}
                    onClick={() => {
                      startSignIn(familyLogin);
                    }}
                  >
                    {t('onboarding.connect.orSignIn', { name: familyLogin.name })}
                  </button>
                )}
              </>
            )}
          </div>
          <OutcomeLine
            outcome={outcome}
            onSkip={onDone}
            onProxy={() => {
              window.location.hash = '#/settings/proxy';
            }}
          />
          {signIn.failure === '' ? null : (
            <p className="error-text small" role="alert">
              {t('providers.failed', { reason: signIn.failure })}
            </p>
          )}
          <div className="onboarding-actions">
            <Button
              variant="ghost"
              data-testid="onboarding-back"
              onClick={() => {
                attempt.current += 1;
                setKey('');
                onBack();
              }}
            >
              {t(backLabel)}
            </Button>
            {current.kind === 'login' && !done ? null : (
              <Button
                type="submit"
                variant="primary"
                data-testid="onboarding-submit"
                loading={busy}
              >
                {t(primaryLabel)}
              </Button>
            )}
          </div>
          {note === undefined || done ? null : <p className="onboarding-note">{note}</p>}
        </form>
      </div>
      {choosing ? (
        <ServiceChooser
          settings={settings}
          onCancel={() => {
            setChoosing(false);
          }}
          onPick={(picked: ServiceChoice) => {
            setChoosing(false);
            if (picked.type === 'login') {
              pick({ kind: 'login' });
              startSignIn(picked.provider);
              return;
            }
            if (picked.kind === 'custom' || picked.kind === 'local') {
              pick({ kind: picked.kind });
              return;
            }
            if (picked.kind === 'cloud') {
              // Cloud platforms need a region and a project: Settings has their form.
              window.location.hash = '#/settings/providers';
              return;
            }
            const owner = families.find((f) => f.variants.some((v) => v.id === picked.id));
            if (owner !== undefined) {
              pick({ kind: 'family', family: owner.id });
              setVariants((old) => ({ ...old, [owner.id]: picked.id }));
              return;
            }
            pick({ kind: 'builtin', id: picked.id });
          }}
        />
      ) : null}
      {signIn.dialog}
    </section>
  );
}

function Tile({
  mark,
  name,
  detail,
  connected,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly detail: string;
  readonly connected: boolean;
}) {
  const t = useT();
  return (
    <>
      <span className="onboarding-tile-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="onboarding-tile-text">
        <span className="onboarding-tile-name">{name}</span>
        <span className="onboarding-tile-detail">
          {connected ? t('onboarding.tile.connected') : detail}
        </span>
      </span>
    </>
  );
}

function LoginList({
  providers,
  disabled,
  onPick,
}: {
  readonly providers: readonly LoginProvider[];
  readonly disabled: boolean;
  readonly onPick: (provider: LoginProvider) => void;
}) {
  const t = useT();
  return (
    <ul className="onboarding-logins">
      {providers.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className="onboarding-login"
            data-testid={`onboarding-login-${p.id}`}
            disabled={disabled}
            onClick={() => {
              onPick(p);
            }}
          >
            <span className="onboarding-tile-mark" aria-hidden="true">
              <ProviderMark provider={p} size={20} />
            </span>
            <span className="onboarding-tile-text">
              <span className="onboarding-tile-name">{p.name}</span>
              <span className="onboarding-tile-detail">
                {p.signedIn
                  ? (p.account ?? t('onboarding.tile.connected'))
                  : p.subscription
                    ? t('providers.signIn.subscription')
                    : p.label}
              </span>
            </span>
            <ChevronRightIcon size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function OutcomeLine({
  outcome,
  onSkip,
  onProxy,
}: {
  readonly outcome: Outcome;
  readonly onSkip: () => void;
  readonly onProxy: () => void;
}) {
  const t = useT();
  const { format } = useApp();
  if (outcome.state === 'idle') return null;
  if (outcome.state === 'busy')
    return (
      <p className="onboarding-outcome muted" role="status" data-testid="onboarding-testing">
        {t('onboarding.connect.testing')}
      </p>
    );
  if (outcome.state === 'ok') {
    const parts = [
      outcome.account,
      outcome.model,
      outcome.latencyMs === undefined
        ? undefined
        : t('onboarding.connect.latency', { ms: format.number(outcome.latencyMs) }),
    ].filter((part): part is string => part !== undefined);
    return (
      <p className="onboarding-outcome" role="status" data-testid="onboarding-connected">
        <span className="onboarding-ok-mark" aria-hidden="true">
          <ProviderMark provider={{ id: outcome.mark }} size={16} />
        </span>
        <span className="onboarding-outcome-text">
          <strong>{t('onboarding.connect.connected', { name: outcome.name })}</strong>
          {parts.length === 0 ? null : <span className="muted"> · {parts.join(' · ')}</span>}
        </span>
      </p>
    );
  }
  return (
    <div
      className="onboarding-outcome onboarding-failed"
      role="alert"
      data-testid="onboarding-failed"
    >
      <p className="onboarding-outcome-text">
        {t('onboarding.connect.failed', { reason: outcome.message })}
      </p>
      <div className="onboarding-outcome-actions">
        {outcome.network ? (
          <button
            type="button"
            className="onboarding-link"
            data-testid="onboarding-proxy"
            onClick={onProxy}
          >
            {t('login.proxy')}
          </button>
        ) : null}
        <button
          type="button"
          className="onboarding-link"
          data-testid="onboarding-skip"
          onClick={onSkip}
        >
          {t('onboarding.connect.skip')}
        </button>
      </div>
    </div>
  );
}
