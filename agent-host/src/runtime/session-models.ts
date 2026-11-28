// The model and effort of a session (T21): the catalog, the switch preview and the selection.
// The registry checks that the session is idle; these work on Pi's session and the workspace's
// ModelRuntime.
import type { Api, Model } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ModelRef, ModelsListResult, SessionModelSelection } from '@piarc/protocol';

import {
  capabilities,
  supportedEffort,
  supportedEfforts,
  switchPreview,
  withReviewer,
} from '../providers/catalog.js';
import { AhpError } from '../protocol/errors.js';
import { loginProviders } from '../providers/login.js';
import type { Workspace } from './workspace.js';

/** The configured providers and models, with `session`'s selection when given. */
export async function listModels(
  workspace: Workspace,
  session: AgentSession | undefined,
): Promise<ModelsListResult> {
  const runtime = workspace.modelRuntime;
  const providers = getBuiltinProviders().flatMap((id) => {
    const provider = runtime.getProvider(id);
    return provider?.auth.apiKey ? [{ id, name: provider.name }] : [];
  });
  const models = (await runtime.getAvailable()).map((m) =>
    withReviewer(workspace.preferences.apply(capabilities(m))),
  );
  const model = session?.model;
  return {
    providers,
    models,
    loginProviders: await loginProviders(runtime, workspace.credentials),
    ...(session && model
      ? {
          model: { provider: model.provider, id: model.id },
          ...(session.thinkingLevel === 'minimal' ? {} : { effort: session.thinkingLevel }),
        }
      : {}),
  };
}

function target(workspace: Workspace, ref: ModelRef) {
  const model = workspace.modelRuntime.getModel(ref.provider, ref.id);
  if (!model) throw new AhpError('notFound', 'The selected model is unavailable');
  return model;
}

export function previewSwitch(workspace: Workspace, session: AgentSession, ref: ModelRef) {
  const current: Model<Api> | undefined = session.model;
  const preview = switchPreview(session, target(workspace, ref), workspace.unpriced);
  const last = session.messages.findLast(
    (message) =>
      message.role === 'assistant' &&
      message.provider === current?.provider &&
      message.model === current.id &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted',
  );
  const used =
    last?.role === 'assistant' && (last.usage.cacheRead > 0 || last.usage.cacheWrite > 0);
  const ttl =
    used && last.usage.cacheWrite1h ? current?.promptCache?.long : current?.promptCache?.short;
  const age = last?.role === 'assistant' ? Date.now() - last.timestamp : Infinity;
  return {
    ...preview,
    ...(current === undefined ? {} : { fromModel: { provider: current.provider, id: current.id } }),
    ...(used && ttl && age >= 0 && age < ttl * 1000 ? { promptCacheWarm: true } : {}),
    ...(ttl ? { cacheTtl: ttl } : {}),
  };
}

/** Switches `session` to `ref`, keeping the effort when the model supports it. */
export async function selectModel(
  workspace: Workspace,
  session: AgentSession,
  ref: ModelRef,
  requested?: string,
): Promise<SessionModelSelection> {
  const model = target(workspace, ref);
  // The model's default effort (per-model setting, T29) applies when none is given.
  const effort = supportedEffort(
    model,
    requested ??
      workspace.preferences.defaultEffort(model, supportedEfforts(model)) ??
      session.thinkingLevel,
  );
  await session.setModel(model);
  session.setThinkingLevel(effort);
  return { model: ref, effort };
}

export function selectEffort(
  workspace: Workspace,
  session: AgentSession,
  requested: string,
): SessionModelSelection {
  const model = session.model;
  if (!model) throw new AhpError('notFound', 'Select a model first');
  const ref = { provider: model.provider, id: model.id };
  const effort = supportedEffort(target(workspace, ref), requested);
  session.setThinkingLevel(effort);
  return { model: ref, effort };
}

/** The settings' defaults of a new session (T31, I113). */
export interface SessionDefaults {
  /** `<provider>/<model id>` or a model id; Core resolved an alias. */
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** The configured model the settings' default names, if any. */
export async function defaultModel(
  workspace: Workspace,
  name: string | undefined,
  log: (line: string) => void,
): Promise<ModelRef | undefined> {
  if (name === undefined) return undefined;
  const available = await workspace.modelRuntime.getAvailable();
  const slash = name.indexOf('/');
  const found =
    slash > 0
      ? available.find((m) => m.provider === name.slice(0, slash) && m.id === name.slice(slash + 1))
      : available.filter((m) => m.id === name).length === 1
        ? available.find((m) => m.id === name)
        : undefined;
  if (found === undefined) {
    log(`the default model ${name} is not a configured model; using the default`);
    return undefined;
  }
  return { provider: found.provider, id: found.id };
}

/** The settings' default effort, when the model supports it and has no default of its own. */
export function applyDefaultEffort(
  workspace: Workspace,
  session: AgentSession,
  effort: string | undefined,
): void {
  // Pi types the session's model loosely (`Model<any>`).
  const model = session.model as Model<Api> | undefined;
  if (effort === undefined || model === undefined) return;
  const supported = supportedEfforts(model);
  if (workspace.preferences.defaultEffort(model, supported) !== undefined) return;
  const level = supported.find((level) => level === effort);
  if (level !== undefined) session.setThinkingLevel(level);
}
