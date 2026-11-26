// Shared state for one workspace (architecture section 5.2).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { CredentialStore } from '@earendil-works/pi-ai';
import { registerLazyBedrockProvider } from '@earendil-works/pi-ai/lazy-bedrock-provider';
import { registerLazyOAuthFlows } from '@earendil-works/pi-ai/lazy-oauth';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { unpricedModels } from '../providers/catalog.js';
import { installProviderPolicy } from '../providers/policy.js';
import { ModelPreferencesStore } from '../providers/preferences.js';

export interface Workspace {
  readonly root: string;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  /** Where the credentials are (ADR-0083: the settings Host reads sign-ins and stored keys). */
  readonly credentials: CredentialStore;
  readonly unpriced: ReadonlySet<string>;
  /** Per-model settings and the auxiliary model from Core (T29). */
  readonly preferences: ModelPreferencesStore;
  reload(allowNetwork: boolean): Promise<void>;
}

export function agentDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi');
}

/** The supplied vault replaces Pi's default auth.json storage. The cache belongs to this agentDir. */
export async function openWorkspace(
  root: string,
  agentDir: string,
  credentials: CredentialStore,
  allowModelNetwork = false,
  catalogBaseUrl?: string,
): Promise<Workspace> {
  mkdirSync(agentDir, { recursive: true });
  registerLazyBedrockProvider();
  // Providers' sign-in flows, bundled (T29): esbuild follows these literal imports.
  registerLazyOAuthFlows();
  const modelsPath = path.join(agentDir, 'models.json');
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath,
    refreshOnCreate: false,
    ...(catalogBaseUrl === undefined ? {} : { catalogBaseUrl }),
  });
  const preferences = new ModelPreferencesStore();
  installProviderPolicy(modelRuntime, (model) => preferences.vision(model));
  let unpriced = new Set<string>();
  let latestRefresh: AbortController | undefined;
  const reload = async (allowNetwork: boolean): Promise<void> => {
    latestRefresh?.abort();
    const controller = new AbortController();
    latestRefresh = controller;
    const prices = await unpricedModels(modelsPath);
    if (controller.signal.aborted) return;
    unpriced = prices;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    await modelRuntime.refresh({
      allowNetwork: allowNetwork && process.env.PI_OFFLINE === undefined,
      signal,
    });
  };
  await reload(allowModelNetwork);
  return {
    root,
    agentDir,
    modelRuntime,
    credentials,
    preferences,
    get unpriced() {
      return unpriced;
    },
    reload,
  };
}
