// The tool rows (architecture section 8.2): the tool group summary (verb + object + lines added
// and removed, expandable to its calls), the bash card (command, directory, Core's semantic
// status, exit code, a timer after ten seconds, where the full output went when it was cut) and
// the file change card (path, line counts, Core's structured diff). States, outcomes and exit
// codes are Core's; nothing is judged here from an exit code or the output.
import type { DiffHunk, Item, ItemStatus } from '@piarc/protocol';
import { memo } from 'react';

import { useT } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import { useExpanded, useTranscriptRow, useTranscriptRows } from '../services.js';
import { useElapsedText, useNow } from './common.js';
import { summarize, targetOf, verbOf, type GroupSummary, type ToolVerb } from './summary.js';

type CommandItem = Extract<Item, { type: 'commandExecution' }>;
type FileChangeItem = Extract<Item, { type: 'fileChange' }>;

/** A running command shows its timer after this long (ms, section 8.2). */
export const BASH_TIMER_AFTER_MS = 10_000;

/** Diff lines a file change card shows before "show all". */
const DIFF_PREVIEW_LINES = 40;

/** Output lines a tool call shows when expanded. */
const OUTPUT_PREVIEW_LINES = 30;

const VERB_MESSAGE: Record<ToolVerb, MessageId> = {
  read: 'transcript.tool.read',
  search: 'transcript.tool.search',
  find: 'transcript.tool.find',
  edit: 'transcript.tool.edit',
  fetch: 'transcript.tool.fetch',
  mcp: 'transcript.tool.mcp',
  agent: 'transcript.tool.agent',
  other: 'transcript.tool.other',
};

const STATUS_MESSAGE: Record<ItemStatus, MessageId> = {
  inProgress: 'transcript.tool.status.inProgress',
  completed: 'transcript.tool.status.completed',
  failed: 'transcript.tool.status.failed',
  declined: 'transcript.tool.status.declined',
  interrupted: 'transcript.tool.status.interrupted',
};

/** The summary as text: "Read 3 files · Edited a.ts". */
export function useSummaryText(): (summary: GroupSummary) => string {
  const t = useT();
  return (summary) =>
    summary.parts
      .map((part) => t(VERB_MESSAGE[part.verb], { count: part.count, target: part.target ?? '' }))
      .join(' · ');
}

/** One tool call's own label ("Read main.ts"), for the working row. */
export function useToolLabel(): (item: Item) => string {
  const t = useT();
  return (item) => t(VERB_MESSAGE[verbOf(item)], { count: 1, target: targetOf(item) });
}

function StatusMark({ status }: { readonly status: ItemStatus }) {
  const t = useT();
  return (
    <span
      className={`tool-status is-${status}`}
      data-status={status}
      title={t(STATUS_MESSAGE[status])}
    >
      <span className="tool-status-dot" aria-hidden="true" />
      <span className="visually-hidden">{t(STATUS_MESSAGE[status])}</span>
    </span>
  );
}

/** Consecutive tool calls as one summary; expands to the calls. */
export function ToolGroupRow({
  id,
  members,
}: {
  readonly id: string;
  readonly members: readonly string[];
}) {
  const t = useT();
  const items = useMemberItems(members);
  const summary = summarize(items);
  const text = useSummaryText();
  const [expanded, setExpanded] = useExpanded(id, false);
  return (
    <div
      className={`row row-tool-group${expanded ? ' is-expanded' : ''}`}
      data-testid="tool-group"
      data-row-id={id}
      data-status={summary.status}
      data-count={members.length}
    >
      <button
        type="button"
        className="row-disclosure"
        aria-expanded={expanded}
        title={t(expanded ? 'transcript.tool.collapse' : 'transcript.tool.expand')}
        data-testid="tool-group-toggle"
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        <span className="row-disclosure-mark" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <StatusMark status={summary.status} />
        <span className="tool-summary" data-testid="tool-summary">
          {text(summary)}
        </span>
        {summary.added > 0 || summary.removed > 0 ? (
          <span className="diff-counts" data-testid="tool-lines">
            <span className="diff-added">+{summary.added}</span>{' '}
            <span className="diff-removed">−{summary.removed}</span>
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="tool-calls" data-testid="tool-calls">
          {members.map((member) => (
            <ToolCall key={member} id={member} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The items of a group's members, re-rendering when any of them changes. */
function useMemberItems(members: readonly string[]): Item[] {
  return useTranscriptRows(members).flatMap((row) => (row?.kind === 'item' ? [row.item] : []));
}

/** One call inside an expanded group. */
const ToolCall = memo(function ToolCall({ id }: { readonly id: string }) {
  const row = useTranscriptRow(id);
  const label = useToolLabel();
  const t = useT();
  const [open, setOpen] = useExpanded(`call:${id}`, false);
  if (row?.kind !== 'item') {
    return null;
  }
  const { item } = row;
  if (item.type === 'fileChange') {
    return <FileChangeCard id={id} item={item} />;
  }
  const output = ('output' in item ? item.output : undefined) ?? undefined;
  return (
    <div className="tool-call" data-testid="tool-call" data-row-id={id} data-status={item.status}>
      <button
        type="button"
        className="row-disclosure"
        aria-expanded={open}
        disabled={output === undefined || output === ''}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <StatusMark status={item.status} />
        <span className="tool-call-label">{label(item)}</span>
      </button>
      {open && output !== undefined ? (
        <pre className="tool-output" aria-label={t('transcript.tool.output')}>
          {lastLines(output, OUTPUT_PREVIEW_LINES)}
        </pre>
      ) : null}
    </div>
  );
});

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\n$/u, '').split('\n');
  return lines.length <= count ? lines.join('\n') : lines.slice(-count).join('\n');
}

/** A shell command. */
export function BashCard({
  id,
  item,
  startedAt,
}: {
  readonly id: string;
  readonly item: CommandItem;
  readonly startedAt: number | undefined;
}) {
  const t = useT();
  const elapsedText = useElapsedText();
  const running = item.status === 'inProgress';
  const now = useNow(1000, running && startedAt !== undefined);
  const elapsed = startedAt === undefined ? 0 : now - startedAt;
  const execution = item.execution ?? undefined;
  const exitCode = execution?.exitCode ?? undefined;
  const signal = execution?.signal ?? undefined;
  const meaning = execution?.meaning ?? undefined;
  const fullOutputPath = execution?.fullOutputPath ?? undefined;
  const cwdReset = execution?.cwdReset ?? undefined;
  const [open, setOpen] = useExpanded(id, false);
  const output = item.output ?? '';
  const outcome = execution?.outcome ?? (item.status === 'completed' ? 'success' : 'failure');
  return (
    <div
      className={`row row-bash is-${item.status}`}
      data-testid="bash-card"
      data-row-id={id}
      data-status={item.status}
      data-outcome={running ? 'running' : outcome}
    >
      <div className="bash-head">
        <StatusMark status={item.status} />
        <span className="bash-label">{t('transcript.bash.label')}</span>
        {execution === undefined ? null : (
          <span className="bash-cwd" data-testid="bash-cwd" title={execution.cwd}>
            {t('transcript.bash.cwd', { cwd: execution.cwd })}
          </span>
        )}
        <span className="bash-state" data-testid="bash-state">
          {running
            ? elapsed >= BASH_TIMER_AFTER_MS
              ? t('transcript.bash.running', { elapsed: elapsedText(elapsed) })
              : t('transcript.tool.status.inProgress')
            : item.status === 'completed' || item.status === 'failed'
              ? t(outcome === 'success' ? 'transcript.bash.success' : 'transcript.bash.failure')
              : t(STATUS_MESSAGE[item.status])}
        </span>
        {exitCode === undefined ? null : (
          <span className="bash-exit" data-testid="bash-exit">
            {t('transcript.bash.exit', { code: exitCode })}
            {meaning === undefined ? '' : ` · ${meaning}`}
          </span>
        )}
        {signal === undefined ? null : (
          <span className="bash-exit">{t('transcript.bash.signal', { signal })}</span>
        )}
        {execution === undefined ? null : (
          <span className="bash-duration">
            {t('transcript.bash.duration', { seconds: (execution.durationMs / 1000).toFixed(1) })}
          </span>
        )}
      </div>
      <pre className="bash-command" data-testid="bash-command">
        <span className="bash-prompt" aria-hidden="true">
          ${' '}
        </span>
        {item.command}
      </pre>
      {execution?.timedOut === true ? (
        <div className="row-status is-warning">
          {t('transcript.bash.timedOut', { seconds: Math.round(execution.timeoutMs / 1000) })}
        </div>
      ) : null}
      {execution?.truncated === true && fullOutputPath !== undefined ? (
        <div className="row-status muted" data-testid="bash-truncated">
          {t('transcript.bash.truncated', { path: fullOutputPath })}
        </div>
      ) : null}
      {cwdReset === undefined ? null : (
        <div className="row-status muted">
          {t('transcript.bash.cwdReset', { path: cwdReset.resetTo, reason: cwdReset.reason })}
        </div>
      )}
      {output === '' ? null : (
        <>
          <button
            type="button"
            className="row-action"
            data-testid="bash-output-toggle"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {t(open ? 'transcript.bash.hideOutput' : 'transcript.bash.showOutput')}
          </button>
          {open || running ? (
            <pre className="tool-output" data-testid="bash-output">
              {lastLines(output, open ? Number.MAX_SAFE_INTEGER : OUTPUT_PREVIEW_LINES / 3)}
            </pre>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A file change with Core's diff. */
export function FileChangeCard({
  id,
  item,
}: {
  readonly id: string;
  readonly item: FileChangeItem;
}) {
  const t = useT();
  const diff = item.diff ?? undefined;
  const [all, setAll] = useExpanded(`diff:${id}`, false);
  return (
    <div
      className={`row row-file-change is-${item.status}`}
      data-testid="file-change-card"
      data-row-id={id}
      data-status={item.status}
    >
      <div className="file-change-head">
        <StatusMark status={item.status} />
        <span className="file-change-path" data-testid="file-change-path" title={item.path}>
          {item.path}
        </span>
        {diff?.created === true ? (
          <span className="badge">{t('transcript.file.created')}</span>
        ) : null}
        {diff === undefined ? null : (
          <span className="diff-counts" data-testid="file-change-lines">
            <span className="diff-added">+{diff.added}</span>{' '}
            <span className="diff-removed">−{diff.removed}</span>
          </span>
        )}
      </div>
      {diff === undefined ? (
        item.status === 'inProgress' ? null : (
          <div className="row-status muted">{t('transcript.file.noDiff')}</div>
        )
      ) : diff.degraded === true || diff.hunks.length === 0 ? (
        <div className="row-status muted">{t('transcript.file.degraded')}</div>
      ) : (
        <DiffView
          hunks={diff.hunks}
          limit={all ? Number.MAX_SAFE_INTEGER : DIFF_PREVIEW_LINES}
          onShowAll={() => {
            setAll(true);
          }}
        />
      )}
    </div>
  );
}

function DiffView({
  hunks,
  limit,
  onShowAll,
}: {
  readonly hunks: readonly DiffHunk[];
  readonly limit: number;
  readonly onShowAll: () => void;
}) {
  let shown = 0;
  let total = 0;
  const blocks = hunks.map((hunk, index) => {
    total += hunk.lines.length;
    const room = Math.max(0, limit - shown);
    const lines = hunk.lines.slice(0, room);
    shown += lines.length;
    if (lines.length === 0) {
      return null;
    }
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    return (
      <tbody key={index} className="diff-hunk">
        <tr className="diff-hunk-head">
          <td colSpan={3}>
            @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </td>
        </tr>
        {lines.map((line, at) => {
          const old = line.kind === 'added' ? '' : String(oldLine++);
          const now = line.kind === 'removed' ? '' : String(newLine++);
          return (
            <tr key={at} className={`diff-line is-${line.kind}`} data-kind={line.kind}>
              <td className="diff-gutter">{old}</td>
              <td className="diff-gutter">{now}</td>
              <td className="diff-text">
                <span className="diff-sign" aria-hidden="true">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                {line.text}
              </td>
            </tr>
          );
        })}
      </tbody>
    );
  });
  return (
    <div className="diff" data-testid="diff">
      <table className="diff-table">{blocks}</table>
      {total > shown ? (
        <button
          type="button"
          className="row-action"
          data-testid="diff-show-all"
          onClick={onShowAll}
        >
          +{total - shown}
        </button>
      ) : null}
    </div>
  );
}
