// Anthropic Messages capability table (T48). The API's threshold compaction supports
// fewer models than tool clearing. See https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
// and https://platform.claude.com/docs/en/build-with-claude/context-editing.
import type { Api, Model } from '@earendil-works/pi-ai';
import type { CatalogModel, ServerContextEdit } from '@piarc/protocol';

const SUMMARIZE = new Set([
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-fable-5-2',
  'claude-mythos-5',
  'claude-mythos-5-1',
  'claude-mythos-5-2',
  'claude-mythos-preview',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

const CLEAR_ONLY = new Set([
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

export function serverContextEdits(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
): Pick<CatalogModel, 'serverContextEdits'> {
  if (model.provider !== 'anthropic' || model.api !== 'anthropic-messages') return {};
  const edits: ServerContextEdit[] = SUMMARIZE.has(model.id)
    ? ['clearTools', 'compact']
    : CLEAR_ONLY.has(model.id)
      ? ['clearTools']
      : [];
  return edits.length === 0 ? {} : { serverContextEdits: edits };
}
