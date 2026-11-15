// What the sessions of one workspace share: the workspace root, PiArc's Pi agent directory and
// one ModelRuntime (architecture section 5.2).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface Workspace {
  /** Absolute path of the workspace root, from `core/welcome`. */
  readonly root: string;
  /** Pi's agent directory: `<PiArc data dir>/pi` (architecture section 5.5). */
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
}

/** The Pi agent directory inside PiArc's data directory. */
export function agentDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi');
}

/**
 * Opens the workspace's shared state. Credentials live only in memory until the credential
 * vault (T08) backs them, so no `auth.json` is written under `pi/` (architecture section 9.1).
 * Model definitions come from `<agentDir>/models.json`; the catalog is not refreshed over the
 * network.
 */
export async function openWorkspace(root: string, agentDir: string): Promise<Workspace> {
  mkdirSync(agentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: path.join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  return { root, agentDir, modelRuntime };
}
