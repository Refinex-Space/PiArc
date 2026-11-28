// "Add a service" (T21, T29): every way to connect a model provider in one searchable dialog,
// grouped as account sign-in, API-key providers, cloud platforms, and custom or local endpoints.
// Picking an account starts its sign-in; picking anything else opens the provider form preset to
// it. Configured providers are left out (a provider is configured once); a provider signed in
// already stays, to add another account (ADR-0083).
import { useId, useMemo, useState, type ReactNode } from 'react';

import { useT } from '../app/app-context.js';
import { Dialog } from '../shell/Dialog.js';
import { ChevronRightIcon, ProviderMark, SearchIcon } from '../shell/icons.js';
import type { MessageId } from '../../shared/i18n/index.js';
import {
  CLOUD_PROVIDERS,
  type Kind,
  type LoginProvider,
  type ProviderSettings,
} from './provider-form.js';

export type ServiceChoice =
  | { readonly type: 'login'; readonly provider: LoginProvider }
  | { readonly type: 'provider'; readonly kind: Kind; readonly id: string };

interface Item {
  readonly key: string;
  readonly testId: string;
  readonly rowTestId?: string;
  readonly name: string;
  /** The provider's mark (ADR-0107). */
  readonly mark: ReactNode;
  readonly detail?: string;
  readonly badge?: string;
  readonly choice: ServiceChoice;
}

interface Group {
  readonly title: MessageId;
  readonly items: readonly Item[];
}

function matches(item: Item, query: string): boolean {
  if (query === '') return true;
  const text = `${item.name} ${item.detail ?? ''} ${item.key}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .every((word) => text.includes(word));
}

export function ServiceChooser({
  settings,
  onPick,
  onCancel,
}: {
  readonly settings: ProviderSettings;
  readonly onPick: (choice: ServiceChoice) => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const groups = useMemo<Group[]>(() => {
    const configured = new Set(settings.providers.map((p) => p.id));
    const builtin = settings.builtinProviders.filter((p) => !configured.has(p.id));
    return [
      {
        title: 'providers.chooser.accounts',
        // A provider signed in already takes another account (ADR-0083).
        items: settings.loginProviders.map((p) => ({
          key: `login:${p.id}`,
          testId: `login-${p.id}`,
          rowTestId: `login-provider-${p.id}`,
          name: p.name,
          mark: <ProviderMark provider={p} size={20} />,
          ...(p.signedIn
            ? { detail: t('providers.chooser.signedIn') }
            : p.label === p.name
              ? {}
              : { detail: p.label }),
          ...(p.subscription ? { badge: t('providers.signIn.subscription') } : {}),
          choice: { type: 'login', provider: p },
        })),
      },
      {
        title: 'providers.chooser.apiKey',
        items: builtin
          .filter((p) => !CLOUD_PROVIDERS.includes(p.id))
          .map((p) => ({
            key: p.id,
            testId: `provider-choice-${p.id}`,
            name: p.name,
            mark: <ProviderMark provider={p} size={20} />,
            choice: { type: 'provider', kind: 'builtin', id: p.id },
          })),
      },
      {
        title: 'providers.chooser.cloud',
        items: builtin
          .filter((p) => CLOUD_PROVIDERS.includes(p.id))
          .map((p) => ({
            key: p.id,
            testId: `provider-choice-${p.id}`,
            name: p.name,
            mark: <ProviderMark provider={p} size={20} />,
            choice: { type: 'provider', kind: 'cloud', id: p.id },
          })),
      },
      {
        title: 'providers.chooser.endpoints',
        items: (['custom', 'local'] as const).map((kind) => ({
          key: kind,
          testId: `provider-choice-${kind}`,
          name: t(`providers.${kind}`),
          mark: <ProviderMark provider={{ id: kind }} local={kind === 'local'} size={20} />,
          detail: t(`providers.chooser.${kind}Detail`),
          choice: { type: 'provider', kind, id: '' },
        })),
      },
    ];
  }, [settings, t]);
  const trimmed = query.trim();
  const shown = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => matches(item, trimmed)) }))
    .filter((group) => group.items.length > 0);
  const first = shown[0]?.items[0];
  return (
    <Dialog
      labelledBy={titleId}
      onCancel={onCancel}
      testId="service-chooser"
      className="service-chooser"
      wide
      dismissOnBackdrop
    >
      <h2 id={titleId} className="dialog-title">
        {t('providers.chooser.title')}
      </h2>
      <div className="service-search">
        <SearchIcon />
        <input
          className="input"
          type="search"
          data-autofocus
          data-testid="service-search"
          aria-label={t('providers.chooser.search')}
          placeholder={t('providers.chooser.search')}
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first !== undefined) {
              e.preventDefault();
              onPick(first.choice);
            }
          }}
        />
      </div>
      <div className="service-groups">
        {shown.length === 0 ? (
          <div className="service-empty" role="status">
            <p className="muted">{t('providers.chooser.none', { query: trimmed })}</p>
            <button
              type="button"
              className="service-item"
              data-testid="provider-choice-custom"
              onClick={() => {
                onPick({ type: 'provider', kind: 'custom', id: '' });
              }}
            >
              <span className="service-item-text">
                <span className="service-item-name">{t('providers.chooser.useCustom')}</span>
              </span>
              <ChevronRightIcon />
            </button>
          </div>
        ) : (
          shown.map((group) => (
            <section key={group.title} className="service-group" aria-label={t(group.title)}>
              <h3 className="service-group-title">{t(group.title)}</h3>
              <ul className="service-grid">
                {group.items.map((item) => (
                  <li key={item.key} data-testid={item.rowTestId}>
                    <button
                      type="button"
                      className="service-item"
                      data-testid={item.testId}
                      onClick={() => {
                        onPick(item.choice);
                      }}
                    >
                      <span className="service-item-mark" aria-hidden="true">
                        {item.mark}
                      </span>
                      <span className="service-item-text">
                        <span className="service-item-name">
                          {item.name}
                          {item.badge === undefined ? null : (
                            <span className="service-badge">{item.badge}</span>
                          )}
                        </span>
                        {item.detail === undefined ? null : (
                          <span className="service-item-detail">{item.detail}</span>
                        )}
                      </span>
                      <ChevronRightIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
}
