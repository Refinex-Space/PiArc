// Shared state for one workspace (architecture section 5.2).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { CredentialStore } from '@earendil-works/pi-ai';
import { registerLazyBedrockProvider } from '@earendil-works/pi-ai/lazy-bedrock-provider';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { unpricedModels } from '../providers/catalog.js';
import { installProviderPolicy } from '../providers/policy.js';

export interface Workspace {
  readonly root: string;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly unpriced: ReadonlySet<string>;
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
  const modelsPath = path.join(agentDir, 'models.json');
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath,
    refreshOnCreate: false,
    ...(catalogBaseUrl === undefined ? {} : { catalogBaseUrl }),
  });
  installProviderPolicy(modelRuntime);
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
    get unpriced() {
      return unpriced;
    },
    reload,
  };
}
