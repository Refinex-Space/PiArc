// The same model directory drives first-turn selection, in-session switching and attachments.
// Session and workspace directory responses come from Core as JSON.
import { useEffect, useState } from 'react';
import type {
  ModelRef,
  ModelsListResult,
  ModelSwitchPreviewResult,
  CatalogModel,
  EffortLevel,
} from '@piarc/protocol';
import { reason } from './errors.js';

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = EffortLevel;
export type ModelChoice = CatalogModel;
export type Catalog = Pick<ModelsListResult, 'models' | 'model' | 'effort'>;
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
  return {
    models,
    ...(modelRef(v.model) ? { model: v.model } : {}),
    ...(isEffort(v.effort) ? { effort: v.effort } : {}),
  };
}

export function useModelCatalog(target: string | undefined, session: boolean) {
  const [data, setData] = useState<{ target: string; catalog: Catalog }>();
  const [failure, setFailure] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'providersChanged') setVersion((v) => v + 1);
      }),
    [],
  );
  useEffect(() => {
    let current = true;
    setFailure(undefined);
    if (target !== undefined) {
      const promise = session
        ? window.piarc.sessionModels(target)
        : window.piarc.workspaceModels(target);
      promise
        .then(parseCatalog)
        .then((catalog) => {
          if (current) setData({ target, catalog });
        })
        .catch((e: unknown) => {
          if (current) {
            setData(undefined);
            setFailure(reason(e));
          }
        });
    }
    return () => {
      current = false;
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

export type SwitchPreview = Required<ModelSwitchPreviewResult>;
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
