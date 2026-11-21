// What a screen reader hears when it enters a transcript row (T43, architecture section 8.7): a
// short description of the row, "Tool calls: Read notes.txt · Searched for Friday, done", from
// the same messages the row shows. The row's content stays readable after it.
//
// `ROW_KINDS` (`shared/row-kinds.ts`) is every kind of row the transcript renders; `rowKind` maps a
// row to one, so a new item type fails to compile until it has a kind and a label, and the
// accessibility state list (`apps/desktop/e2e/a11y/states.ts`) must list it (`states.test.ts`).
// Approval cards are not here: a card names itself and is announced when it appears.
import type { Item } from '@piarc/protocol';

import type { MessageId } from '../../shared/i18n/index.js';
import { ROW_KINDS, type RowKind } from '../../shared/row-kinds.js';
import type { TranscriptRow } from '../store/transcript.js';
import { OWN_ROW_TOOLS } from '../store/transcript.js';
import { planStatus, taskListOf } from './rows/harness.js';
import { ERROR_TITLE } from './rows/status.js';
import { STATUS_MESSAGE, summarize, VERB_MESSAGE } from './rows/summary.js';

export { ROW_KINDS, type RowKind };

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

const HOST_TOOL_KIND: Readonly<Record<string, RowKind>> = {
  TodoWrite: 'todo',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'question',
  SuggestNextSteps: 'nextSteps',
};

/** The kind of `row` as `RowView` renders it; approval cards have none. */
export function rowKind(row: TranscriptRow): RowKind | undefined {
  switch (row.kind) {
    case 'item':
      break;
    case 'approval':
      return undefined;
    default:
      return row.kind;
  }
  const { item } = row;
  switch (item.type) {
    case 'userMessage':
    case 'agentMessage':
    case 'reasoning':
    case 'commandExecution':
    case 'fileChange':
    case 'permissionModeChanged':
    case 'contextCompaction':
    case 'reminder':
    case 'subagent':
    case 'webSearch':
      return item.type;
    case 'dynamicToolCall':
      if (OWN_ROW_TOOLS.has(item.tool)) return HOST_TOOL_KIND[item.tool] ?? 'group';
      return 'group';
    case 'mcpToolCall':
    case 'webFetch':
      return 'group';
  }
}

/** The longest excerpt of a message a label quotes. */
export const LABEL_EXCERPT_CHARS = 80;

function excerpt(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > LABEL_EXCERPT_CHARS ? `${line.slice(0, LABEL_EXCERPT_CHARS - 1)}…` : line;
}

type ItemOf<T extends Item['type']> = Extract<Item, { type: T }>;

function itemLabel(item: Item, t: Translate, members: readonly Item[]): string {
  const status = t(STATUS_MESSAGE[item.status]);
  switch (item.type) {
    case 'userMessage':
      return t('a11y.row.userMessage', { text: excerpt(item.text) });
    case 'agentMessage':
      return item.status === 'inProgress'
        ? t('a11y.row.agentMessageStreaming')
        : t('a11y.row.agentMessage', { text: excerpt(item.text) });
    case 'reasoning':
      return t(item.status === 'inProgress' ? 'a11y.row.reasoningActive' : 'a11y.row.reasoning');
    case 'commandExecution':
      return t('a11y.row.command', { command: excerpt(item.command), status });
    case 'fileChange':
      return t('a11y.row.fileChange', {
        path: item.path,
        added: item.diff?.added ?? 0,
        removed: item.diff?.removed ?? 0,
        status,
      });
    case 'permissionModeChanged':
      return t('approval.modeChanged', { mode: t(`approval.mode.${item.mode}`) });
    case 'contextCompaction':
      return t(
        item.status === 'inProgress'
          ? 'transcript.compaction.running'
          : item.status === 'completed'
            ? 'transcript.compaction.doneShort'
            : 'a11y.row.compactionFailed',
      );
    case 'reminder':
      return t('transcript.reminder.title', {
        kinds: [...new Set(item.reminders.map((r) => t(`transcript.reminder.${r.type}`)))].join(
          t('transcript.reminder.separator'),
        ),
      });
    case 'subagent':
      return t('a11y.row.subagent', {
        type: item.subagent?.agentType ?? item.tool,
        task: excerpt(item.subagent?.description ?? item.description ?? ''),
        status,
      });
    case 'webSearch':
      return t('a11y.row.webSearch', {
        query: excerpt(item.query),
        count: item.sources?.length ?? 0,
        status,
      });
    case 'dynamicToolCall':
      return hostToolLabel(item, t, members);
    case 'mcpToolCall':
    case 'webFetch':
      return groupLabel(members.length > 0 ? members : [item], t);
  }
}

function hostToolLabel(item: ItemOf<'dynamicToolCall'>, t: Translate, members: readonly Item[]) {
  switch (item.tool) {
    case 'TodoWrite': {
      const todos = taskListOf(item.arguments) ?? [];
      const done = todos.filter((todo) => todo.status === 'completed').length;
      return t('a11y.row.todo', { done, total: todos.length });
    }
    case 'ExitPlanMode':
      return t('a11y.row.plan', { status: t(`plan.status.${planStatus(item)}`) });
    case 'AskUserQuestion':
      return t('a11y.row.question', { status: t(STATUS_MESSAGE[item.status]) });
    case 'SuggestNextSteps':
      return t('next.title');
    default:
      return groupLabel(members.length > 0 ? members : [item], t);
  }
}

function groupLabel(items: readonly Item[], t: Translate): string {
  const summary = summarize(items);
  const text = summary.parts
    .map((part) => t(VERB_MESSAGE[part.verb], { count: part.count, target: part.target ?? '' }))
    .join(' · ');
  return t('a11y.row.group', { summary: text, status: t(STATUS_MESSAGE[summary.status]) });
}

/**
 * The description of `row`; `member` resolves the items of a tool group. `undefined` for an
 * approval card (it names itself).
 */
export function rowLabel(
  row: TranscriptRow,
  t: Translate,
  member: (id: string) => Item | undefined,
): string | undefined {
  switch (row.kind) {
    case 'item':
      return itemLabel(row.item, t, []);
    case 'group': {
      const items = row.members.flatMap((id) => {
        const item = member(id);
        return item === undefined ? [] : [item];
      });
      return groupLabel(items, t);
    }
    case 'optimistic':
      return t(row.state === 'undelivered' ? 'a11y.row.undelivered' : 'a11y.row.sending', {
        text: excerpt(row.input.text),
      });
    case 'error':
      return t('a11y.row.error', { title: t(ERROR_TITLE[row.errorKind]) });
    case 'uncertain':
      return t('transcript.uncertain');
    case 'working':
      return t('a11y.row.working');
    case 'approval':
      return undefined;
  }
}
