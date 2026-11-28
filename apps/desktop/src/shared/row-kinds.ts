// Every kind of row the transcript renders (`renderer/transcript/rows/RowView.tsx`): the
// renderer names each one for screen readers (`renderer/transcript/row-label.ts`), and the
// accessibility state list (`e2e/a11y/states.ts`) must list each one (`e2e/a11y/states.test.ts`).
// Shared because both the renderer and the L4 tests read it.
export const ROW_KINDS = [
  'userMessage',
  'optimistic',
  'agentMessage',
  'reasoning',
  'group',
  'commandExecution',
  'fileChange',
  'error',
  'uncertain',
  'working',
  'permissionModeChanged',
  'contextCompaction',
  'reminder',
  'subagent',
  'webSearch',
  'browser',
  'todo',
  'plan',
  'question',
  'nextSteps',
] as const;

export type RowKind = (typeof ROW_KINDS)[number];
