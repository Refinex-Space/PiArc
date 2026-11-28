// The rewind dialog's logic (T28, architecture section 6.9): Core's preview and report parsed
// from JSON, which choices a scope needs, and the request the dialog sends. Conflicting files
// start on "keep the current content": overwriting is the user's explicit choice.
import type {
  FileOutcome,
  FileResult,
  RewindAction,
  RewindFile,
  RewindPreview,
  RewindReport,
  RewindRequest,
  RewindScope,
} from '@piarc/protocol';

/** The four options, in the order the dialog lists them. */
export const SCOPES: readonly RewindScope[] = [
  'codeAndConversation',
  'conversation',
  'code',
  'summarize',
];

const ACTIONS = new Set<RewindAction>(['restore', 'delete', 'unchanged', 'conflict']);
const OUTCOMES = new Set<FileOutcome>([
  'restored',
  'deleted',
  'unchanged',
  'kept',
  'failed',
  'skipped',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `scope` puts files back. */
export function restoresCode(scope: RewindScope): boolean {
  return scope === 'codeAndConversation' || scope === 'code';
}

function fileOf(value: unknown): RewindFile | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.action !== 'string' ||
    !ACTIONS.has(value.action as RewindAction)
  ) {
    return undefined;
  }
  return {
    path: value.path,
    label: value.label,
    version: value.version,
    action: value.action as RewindAction,
    ...(value.deletes === true ? { deletes: true } : {}),
    ...(value.approval === true ? { approval: true } : {}),
  };
}

/** Core's `RewindPreview` JSON. */
export function previewOf(text: string): RewindPreview {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.turnId !== 'string' || !Array.isArray(value.files)) {
    throw new Error('Core returned a malformed rewind preview');
  }
  return {
    turnId: value.turnId,
    codeAvailable: value.codeAvailable === true,
    files: value.files.flatMap((file: unknown) => {
      const parsed = fileOf(file);
      return parsed === undefined ? [] : [parsed];
    }),
  };
}

function resultOf(value: unknown): FileResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.outcome !== 'string' ||
    !OUTCOMES.has(value.outcome as FileOutcome)
  ) {
    return undefined;
  }
  return {
    path: value.path,
    label: value.label,
    outcome: value.outcome as FileOutcome,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

/** Core's `RewindReport` JSON. */
export function reportOf(text: string): RewindReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.completed !== 'boolean') {
    throw new Error('Core returned a malformed rewind report');
  }
  const conversation = isRecord(value.conversation) ? value.conversation : undefined;
  return {
    completed: value.completed,
    files: Array.isArray(value.files)
      ? value.files.flatMap((file: unknown) => {
          const parsed = resultOf(file);
          return parsed === undefined ? [] : [parsed];
        })
      : [],
    ...(typeof value.restoreId === 'string' ? { restoreId: value.restoreId } : {}),
    ...(conversation === undefined
      ? {}
      : { conversation: typeof conversation.text === 'string' ? { text: conversation.text } : {} }),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

/** Per conflicting file: overwrite with the snapshot (`true`) or keep; keep to start with. */
export function initialChoices(preview: RewindPreview): ReadonlyMap<string, boolean> {
  return new Map(
    preview.files.filter((f) => f.action === 'conflict').map((f) => [f.path, false] as const),
  );
}

/** The request for `scope`, with a choice for every conflict when the files go back. */
export function requestOf(
  preview: RewindPreview,
  scope: RewindScope,
  choices: ReadonlyMap<string, boolean>,
): RewindRequest {
  const conflicts = restoresCode(scope) ? preview.files.filter((f) => f.action === 'conflict') : [];
  return {
    turnId: preview.turnId,
    scope,
    ...(conflicts.length === 0
      ? {}
      : {
          choices: conflicts.map((f) => ({
            path: f.path,
            version: f.version,
            overwrite: choices.get(f.path) === true,
          })),
        }),
  };
}

/** Files that change when the files go back (everything but `unchanged`). */
export function affectedFiles(preview: RewindPreview): readonly RewindFile[] {
  return preview.files.filter((f) => f.action !== 'unchanged');
}
