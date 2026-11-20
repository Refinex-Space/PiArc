// The model alias table (T31, architecture section 6.13): each alias picks a configured model,
// shown with its capabilities. haiku, sonnet and opus follow fast, balanced and strong unless
// set on their own. Saved with the other model preferences (`setModelPreferences`), as the
// user's `modelAliases`; a workspace's `.piarc/settings.json` can set its own.
import { useT } from '../app/app-context.js';
import {
  ALIAS_FOLLOWS,
  MODEL_ALIASES,
  type CatalogEntry,
  type ProviderSettings,
} from './provider-form.js';

const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export function AliasSection({
  settings,
  busy,
  save,
}: {
  readonly settings: ProviderSettings;
  readonly busy: boolean;
  /** Saves the preferences (`setModelPreferences`). */
  readonly save: (preferencesJson: string) => void;
}) {
  const t = useT();
  const models = settings.catalogModels;
  const choose = (alias: string, target: string) => {
    const aliases = Object.fromEntries(
      Object.entries(settings.aliases).filter(([name]) => name !== alias),
    );
    if (target !== '') aliases[alias] = target;
    save(
      JSON.stringify({
        models: settings.models,
        ...(settings.auxiliaryAlias === null
          ? settings.auxiliary === null
            ? {}
            : { auxiliary: settings.auxiliary }
          : { auxiliaryAlias: settings.auxiliaryAlias }),
        aliases,
      }),
    );
  };
  const summary = (model: CatalogEntry | undefined) =>
    model === undefined
      ? undefined
      : t('models.aliases.summary', {
          context: model.contextWindow.toLocaleString(),
          output: model.vision ? 'image' : 'text',
          efforts: model.efforts.join(' / ') || '-',
        });
  return (
    <section className="settings-subsection" data-testid="alias-section">
      <h2 className="settings-heading">{t('models.aliases.title')}</h2>
      <p className="muted small">{t('models.aliases.hint')}</p>
      <ul className="provider-list">
        {MODEL_ALIASES.map((alias) => {
          const own = settings.aliases[alias];
          const tier = ALIAS_FOLLOWS[alias];
          const effective = own ?? (tier === undefined ? undefined : settings.aliases[tier]);
          const model = models.find((m) => keyOf(m) === effective);
          return (
            <li key={alias} data-testid={`alias-row-${alias}`}>
              <div>
                <strong>{t(`models.aliases.${alias}`)}</strong>
                <div className="muted small" data-testid={`alias-summary-${alias}`}>
                  {model === undefined
                    ? (effective ?? t('models.aliases.unset'))
                    : `${model.name} · ${summary(model) ?? ''}`}
                </div>
              </div>
              <select
                className="input"
                aria-label={t(`models.aliases.${alias}`)}
                data-testid={`alias-select-${alias}`}
                disabled={busy}
                value={own ?? ''}
                onChange={(e) => {
                  choose(alias, e.currentTarget.value);
                }}
              >
                <option value="">
                  {tier === undefined
                    ? t('models.aliases.unset')
                    : t('models.aliases.follows', { tier })}
                </option>
                {own !== undefined && !models.some((m) => keyOf(m) === own) ? (
                  <option value={own}>{own}</option>
                ) : null}
                {models.map((m) => (
                  <option key={keyOf(m)} value={keyOf(m)}>
                    {settings.models[keyOf(m)]?.displayName ?? m.name} ({keyOf(m)})
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
