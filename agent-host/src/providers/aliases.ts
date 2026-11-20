// The model alias table (T31, architecture section 6.13): `fast`, `balanced` and `strong`, and
// Claude Code's `haiku`, `sonnet` and `opus`, which follow the first three unless set on their
// own. Values are `<provider>/<model id>`; Core merges the user's PiArc settings with the
// workspace's `.piarc/` files and sends the table with the model preferences.
//
// Resolution order: `inherit` (or nothing) → an alias → `<provider>/<model id>` → a bare model id
// that names exactly one available model. An alias that is not set, or whose model is no longer
// available, falls back to `inherit` with a warning for the subagent card; anything else that
// does not resolve is an error that lists the aliases. Subagents (T31) use it; skills (T37),
// hooks (T38) and the auxiliary model setting (T29) resolve their model through it as well.
import type { Api, Model } from '@earendil-works/pi-ai';

/** A name in the alias table (`piarc_protocol::models::ModelAlias`). */
export type ModelAlias = 'fast' | 'balanced' | 'strong' | 'haiku' | 'sonnet' | 'opus';

/** The aliases, in the order the settings page lists them. */
export const MODEL_ALIASES: readonly ModelAlias[] = [
  'fast',
  'balanced',
  'strong',
  'haiku',
  'sonnet',
  'opus',
];

/** Claude Code's names follow PiArc's tiers unless set on their own. */
const FOLLOWS: Readonly<Partial<Record<ModelAlias, ModelAlias>>> = {
  haiku: 'fast',
  sonnet: 'balanced',
  opus: 'strong',
};

export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value);
}

/** Why a resolution fell back to the inherited model. */
export type AliasWarning =
  | { readonly kind: 'aliasUnset'; readonly alias: ModelAlias }
  | { readonly kind: 'aliasUnavailable'; readonly alias: ModelAlias; readonly target: string };

export type ModelResolution =
  | {
      readonly ok: true;
      readonly model: Model<Api>;
      /** How it was found: the inherited model, an alias (with the setting it used), or by id. */
      readonly via: 'inherit' | 'alias' | 'id';
      readonly alias?: ModelAlias;
      readonly warning?: AliasWarning;
    }
  | { readonly ok: false; readonly message: string };

export interface AliasContext {
  /** Alias → `<provider>/<model id>` as configured. */
  readonly aliases: Readonly<Partial<Record<string, string>>>;
  /** The model `inherit` means: the parent session's. */
  readonly inherit: Model<Api>;
  /** The models with credentials that requests can use. */
  readonly available: readonly Model<Api>[];
}

/** The setting an alias uses: its own, else the tier it follows. */
export function aliasTarget(
  alias: ModelAlias,
  aliases: Readonly<Partial<Record<string, string>>>,
): { readonly target: string; readonly from: ModelAlias } | undefined {
  const own = aliases[alias];
  if (own !== undefined && own !== '') return { target: own, from: alias };
  const tier = FOLLOWS[alias];
  const followed = tier === undefined ? undefined : aliases[tier];
  return tier === undefined || followed === undefined || followed === ''
    ? undefined
    : { target: followed, from: tier };
}

function byFullName(name: string, available: readonly Model<Api>[]): Model<Api> | undefined {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) return undefined;
  const provider = name.slice(0, slash);
  const id = name.slice(slash + 1);
  return available.find((model) => model.provider === provider && model.id === id);
}

/** Resolves a `model` value of a subagent definition or call. */
export function resolveModel(spec: string | undefined, context: AliasContext): ModelResolution {
  const value = spec?.trim() ?? '';
  if (value === '' || value === 'inherit') {
    return { ok: true, model: context.inherit, via: 'inherit' };
  }
  if (isModelAlias(value)) {
    const setting = aliasTarget(value, context.aliases);
    if (setting === undefined) {
      return {
        ok: true,
        model: context.inherit,
        via: 'inherit',
        warning: { kind: 'aliasUnset', alias: value },
      };
    }
    const model = byFullName(setting.target, context.available);
    if (model === undefined) {
      return {
        ok: true,
        model: context.inherit,
        via: 'inherit',
        warning: { kind: 'aliasUnavailable', alias: value, target: setting.target },
      };
    }
    return { ok: true, model, via: 'alias', alias: setting.from };
  }
  const full = byFullName(value, context.available);
  if (full !== undefined) return { ok: true, model: full, via: 'id' };
  if (!value.includes('/')) {
    const matches = context.available.filter((model) => model.id === value);
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) return { ok: true, model: only, via: 'id' };
  }
  return {
    ok: false,
    message:
      `Unknown model "${value}". Use inherit, one of the aliases ${MODEL_ALIASES.join(', ')}, ` +
      'or <provider>/<model id> of a configured model.',
  };
}

/** The text of a fallback warning, for logs and the model. */
export function describeAliasWarning(warning: AliasWarning): string {
  return warning.kind === 'aliasUnset'
    ? `The model alias "${warning.alias}" is not set; the subagent uses the parent's model.`
    : `The model alias "${warning.alias}" points to ${warning.target}, which is not available; the subagent uses the parent's model.`;
}
