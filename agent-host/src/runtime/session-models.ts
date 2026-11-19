// The model and effort of a session (T21): the catalog, the switch preview and the selection.
// The registry checks that the session is idle; these work on Pi's session and the workspace's
// ModelRuntime.
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ModelRef, ModelsListResult, SessionModelSelection } from '@piarc/protocol';

import { capabilities, supportedEffort, switchPreview } from '../providers/catalog.js';
import { AhpError } from '../protocol/errors.js';
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
  const models = (await runtime.getAvailable()).map(capabilities);
  const model = session?.model;
  return {
    providers,
    models,
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
  return switchPreview(session, target(workspace, ref), workspace.unpriced);
}

/** Switches `session` to `ref`, keeping the effort when the model supports it. */
export async function selectModel(
  workspace: Workspace,
  session: AgentSession,
  ref: ModelRef,
  requested?: string,
): Promise<SessionModelSelection> {
  const model = target(workspace, ref);
  const effort = supportedEffort(model, requested ?? session.thinkingLevel);
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
