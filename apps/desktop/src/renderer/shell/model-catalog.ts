// The same model directory drives first-turn selection, in-session switching and attachments.
// Session and workspace directory responses come from Core as JSON.
import { useEffect, useRef, useState } from 'react';
import type {
  ModelRef,
  ModelsListResult,
  ModelSwitchPreviewResult,
  CatalogModel,
  EffortLevel,
} from '@piarc/protocol';
import { failureKind, reason } from './errors.js';
import type { MenuItem } from './Menu.js';

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = EffortLevel;
export type ModelChoice = CatalogModel;
export type Catalog = Pick<ModelsListResult, 'models' | 'model' | 'effort'> & {
  /** Providers' display names by id (the built-in catalog and the sign-in providers). */
  readonly providerNames?: Readonly<Record<string, string>>;
};
export function keyOf(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}
export function isEffort(value: unknown): value is Effort {
  return EFFORTS.some((e) => e === value);
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function modelRef(v: unknown): v is ModelRef {
  return record(v) && typeof v.provider === 'string' && typeof v.id === 'string';
}
export function parseCatalog(text: string): Catalog {
  const v: unknown = JSON.parse(text);
  if (!record(v) || !Array.isArray(v.models)) throw new Error('Invalid model directory');
  const models = v.models.map((m: unknown): CatalogModel => {
    if (
      !record(m) ||
      !modelRef(m) ||
      typeof m.name !== 'string' ||
      typeof m.vision !== 'boolean' ||
      !Array.isArray(m.efforts) ||
      !m.efforts.every(isEffort) ||
      typeof m.contextWindow !== 'number' ||
      typeof m.maxOutput !== 'number' ||
      (m.toolReliability !== 'unknown' && m.toolReliability !== 'verified') ||
      typeof m.promptCache !== 'boolean'
    ) {
      throw new Error('Invalid model capabilities');
    }
    return {
      provider: m.provider,
      id: m.id,
      name: m.name,
      vision: m.vision,
      efforts: m.efforts,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      toolReliability: m.toolReliability,
      promptCache: m.promptCache,
    };
  });
  const providerNames: Record<string, string> = {};
  for (const list of [v.providers, v.loginProviders]) {
    if (!Array.isArray(list)) continue;
    for (const p of list as unknown[]) {
      if (record(p) && typeof p.id === 'string' && typeof p.name === 'string' && p.name)
        providerNames[p.id] ??= p.name;
    }
  }
  return {
    models,
    providerNames,
    ...(modelRef(v.model) ? { model: v.model } : {}),
    ...(isEffort(v.effort) ? { effort: v.effort } : {}),
  };
}

/**
 * The model rows of a model menu. With models from more than one provider each provider is a
 * row whose submenu holds its models (the search still finds every model); with one provider
 * the models are the rows.
 */
export function modelChoiceItems(
  catalog: Catalog | undefined,
  isSelected: (model: ModelChoice) => boolean,
  choose: (model: ModelChoice) => void,
): MenuItem[] {
  const models = catalog?.models ?? [];
  const groups = new Map<string, ModelChoice[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  const option = (model: ModelChoice, grouped: boolean): MenuItem => {
    const hint = grouped ? (model.name === model.id ? undefined : model.id) : keyOf(model);
    return {
      id: keyOf(model),
      testId: `model-option-${keyOf(model)}`,
      label: model.name,
      ...(hint === undefined ? {} : { hint }),
      selected: isSelected(model),
      run: () => {
        choose(model);
      },
    };
  };
  if (groups.size < 2) return models.map((model) => option(model, false));
  return [...groups].map(([provider, group]): MenuItem => {
    const current = group.find(isSelected);
    return {
      id: `provider-${provider}`,
      testId: `model-provider-${provider}`,
      label: catalog?.providerNames?.[provider] ?? provider,
      ...(current ? { hint: current.name, selected: true } : {}),
      searchable: true,
      submenu: group.map((model) => option(model, true)),
    };
  });
}

/** Failures that pass once the session or its Agent Host is ready: retried quietly first. */
const TRANSIENT = new Set(['sessionNotFound', 'hostUnavailable', 'busy', 'timeout', 'uncertain']);

/** Waits between the quiet retries (ms); the failure shows once they are used up. */
const RETRY_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/**
 * The models of a session (or of a workspace, for a new one). A failure is not final: a passing
 * one (the session still opening in its Agent Host) is retried quietly, and a shown one is asked
 * again when `again` changes (the session's turn starts or ends), so it clears once things work.
 */
export function useModelCatalog(target: string | undefined, session: boolean, again?: unknown) {
  const [data, setData] = useState<{ target: string; catalog: Catalog }>();
  const [failure, setFailure] = useState<string>();
  const [version, setVersion] = useState(0);
  const failed = useRef(false);
  failed.current = failure !== undefined;
  useEffect(() => {
    if (failed.current) setVersion((v) => v + 1);
  }, [again]);
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'providersChanged') setVersion((v) => v + 1);
      }),
    [],
  );
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (target === undefined) {
      setFailure(undefined);
      return;
    }
    const load = (attempt: number): void => {
      const promise = session
        ? window.piarc.sessionModels(target)
        : window.piarc.workspaceModels(target);
      promise
        .then(parseCatalog)
        .then((catalog) => {
          if (!current) return;
          setData({ target, catalog });
          setFailure(undefined);
        })
        .catch((e: unknown) => {
          if (!current) return;
          const wait = TRANSIENT.has(failureKind(e) ?? '') ? RETRY_MS[attempt] : undefined;
          if (wait !== undefined) {
            timer = setTimeout(() => {
              load(attempt + 1);
            }, wait);
            return;
          }
          setData(undefined);
          setFailure(reason(e));
        });
    };
    load(0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [target, session, version]);
  const catalog = data && data.target === target ? data.catalog : undefined;
  return {
    catalog,
    failure,
    refresh: () => {
      setVersion((v) => v + 1);
    },
  };
}

export type SwitchPreview = Required<
  Pick<
    ModelSwitchPreviewResult,
    'contextTokens' | 'cacheWriteUsd' | 'cacheInvalidated' | 'dropsThinking'
  >
>;
export function parsePreview(text: string): SwitchPreview {
  const v: unknown = JSON.parse(text);
  if (
    !record(v) ||
    (v.contextTokens != null && typeof v.contextTokens !== 'number') ||
    (v.cacheWriteUsd != null && typeof v.cacheWriteUsd !== 'number') ||
    typeof v.cacheInvalidated !== 'boolean' ||
    typeof v.dropsThinking !== 'boolean'
  )
    throw new Error('Invalid model switch preview');
  return {
    contextTokens: v.contextTokens ?? null,
    cacheWriteUsd: v.cacheWriteUsd ?? null,
    cacheInvalidated: v.cacheInvalidated,
    dropsThinking: v.dropsThinking,
  };
}
