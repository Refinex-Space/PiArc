// The tool rows (architecture section 8.2): the tool group summary (verb + object + lines added
// and removed, expandable to its calls), the shell command (command, Core's semantic status,
// exit code, duration, where the full output went when it was cut, the output on demand) and
// the file change (path, line counts, Core's structured diff). States, outcomes and exit codes
// are Core's; nothing is judged here from an exit code or the output. Each is a step row
// (ADR-0078): the verb in the secondary ink, the object in the primary ink, a caret at the end.
import type { DiffHunk, Item, ItemStatus } from '@piarc/protocol';
import { memo, type ReactNode } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { ExternalGlyph } from '../../shell/icons.js';
import {
  useExpanded,
  useLiveTail,
  useTranscriptRow,
  useTranscriptRows,
  useTranscriptView,
} from '../services.js';
import { useDetail } from '../detail.js';
import { ThinkingRow } from './messages.js';
import { WebSearchCard } from './web-search.js';
import { ProjectImage, useProjectImage } from '../markdown/ReplyImage.js';
import { useElapsedText, useNow } from './common.js';
import { revealBidi } from '../reveal.js';
import { projectPath } from '../../files/file-path.js';
import { ReviewNote } from './review.js';
import { CommandText, DiffPill, Segments, StepRow, type StepState } from './parts.js';
import {
  STATUS_MESSAGE,
  readPath,
  baseName,
  summarize,
  targetOf,
  VERB_MESSAGE,
  verbOf,
  type GroupSummary,
  type ToolPart,
} from './summary.js';

type CommandItem = Extract<Item, { type: 'commandExecution' }>;
type FileChangeItem = Extract<Item, { type: 'fileChange' }>;

/** A running command shows its timer after this long (ms, section 8.2). */
export const BASH_TIMER_AFTER_MS = 10_000;

/** Diff lines a file change shows before "show all". */
const DIFF_PREVIEW_LINES = 40;

/** Output lines a tool call shows when expanded. */
const OUTPUT_PREVIEW_LINES = 30;

/** Output lines a running command shows under its row. */
const LIVE_OUTPUT_LINES = 10;

/** Stands in for a part's object while its message is formatted, so the object gets its ink. */
const TARGET = '\u{E000}';

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

/** A part of a summary: its words in the line's ink, its object in the primary ink. */
function PartText({ part }: { readonly part: ToolPart }) {
  const t = useT();
  const text = t(VERB_MESSAGE[part.verb], { count: part.count, target: TARGET });
  if (part.target === undefined || !text.includes(TARGET)) {
    return t(VERB_MESSAGE[part.verb], { count: part.count, target: part.target ?? '' });
  }
  const [before = '', after = ''] = text.split(TARGET);
  return (
    <>
      {before}
      <span className="step-object">{revealBidi(part.target)}</span>
      {after}
    </>
  );
}

/** Parts shown before the rest folds into "N more". */
const SUMMARY_PARTS = 3;

function SummaryText({ summary }: { readonly summary: GroupSummary }) {
  const t = useT();
  const folds = summary.parts.length > SUMMARY_PARTS + 1;
  const shown = folds ? summary.parts.slice(0, SUMMARY_PARTS) : summary.parts;
  const rest = summary.parts.length - shown.length;
  return (
    <span className="step-summary">
      {shown.map((part, index) => (
        <span key={part.verb}>
          {index > 0 ? ' · ' : null}
          <PartText part={part} />
        </span>
      ))}
      {rest > 0 ? ` · ${t('transcript.tool.more', { count: rest })}` : null}
    </span>
  );
}

/** The step state a tool call's lifecycle shows as. */
function stepState(status: ItemStatus): StepState {
  switch (status) {
    case 'inProgress':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'denied';
    case 'interrupted':
      return 'stopped';
    case 'completed':
      return 'done';
  }
}

/** The outcome word after a finished call that did not complete. */
function useOutcome(): (status: ItemStatus) => string | undefined {
  const t = useT();
  return (status) =>
    status === 'completed' || status === 'inProgress' ? undefined : t(STATUS_MESSAGE[status]);
}

export function StatusMark({ status }: { readonly status: ItemStatus }) {
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

/** Consecutive tool calls as one summary; one call opens to its content, several to a card. */
export function ToolGroupRow({
  id,
  members,
}: {
  readonly id: string;
  readonly members: readonly string[];
}) {
  const items = useMemberItems(members);
  const summary = summarize(items);
  const outcome = useOutcome();
  // Open while it is the running turn's newest work; folded into its summary once text follows
  // or the turn ends. The user's own choice wins either way (ADR-0079).
  const live = useLiveTail(id);
  const [expanded, setExpanded] = useExpanded(id, live);
  const only = members.length === 1 ? items[0] : undefined;
  const opens = only === undefined || hasBody(only);
  if (only?.type === 'commandExecution' || only?.type === 'webSearch') {
    return <ToolCall id={members[0] ?? ''} />;
  }
  return (
    <div
      className={`row row-tool-group${expanded ? ' is-expanded' : ''}`}
      data-testid="tool-group"
      data-row-id={id}
      data-status={summary.status}
      data-count={members.length}
    >
      <StepRow
        verb={<SummaryText summary={summary} />}
        state={stepState(summary.status)}
        outcome={outcome(summary.status)}
        trail={<DiffPill added={summary.added} removed={summary.removed} testId="tool-lines" />}
        expanded={opens ? expanded : undefined}
        onToggle={() => {
          setExpanded(!expanded);
        }}
        lineTestId="tool-group-toggle"
        notes={
          only !== undefined && 'review' in only && only.review != null ? (
            <ReviewNote review={only.review} />
          ) : undefined
        }
        textTestId="tool-summary"
        aside={only === undefined ? undefined : <CallAside id={members[0] ?? ''} item={only} />}
      >
        {only === undefined ? (
          <div className="tool-calls" data-testid="tool-calls">
            {members.map((member) => (
              <ToolCall key={member} id={member} />
            ))}
          </div>
        ) : (
          <CallBody id={members[0] ?? ''} item={only} />
        )}
      </StepRow>
      {only === undefined ? null : <ReadImage item={only} />}
    </div>
  );
}

/** The items of a group's members, re-rendering when any of them changes. */
function useMemberItems(members: readonly string[]): Item[] {
  return useTranscriptRows(members).flatMap((row) => (row?.kind === 'item' ? [row.item] : []));
}

function outputOf(item: Item): string | undefined {
  const output = ('output' in item ? item.output : undefined) ?? undefined;
  return output === '' ? undefined : output;
}

/** Whether a call has something to show when opened. */
function hasBody(item: Item): boolean {
  return item.type === 'fileChange' || outputOf(item) !== undefined;
}

/** What one call shows when opened: a file change's diff, or the tool's output. */
/** The image a finished Read of an image file returned, under its line (ADR-0080). */
function ReadImage({ item }: { readonly item: Item }) {
  const image = useProjectImage(readPath(item));
  if (image === undefined || item.status !== 'completed') return null;
  return (
    <span className="tool-image">
      <ProjectImage path={image} alt={baseName(image)} fallback={null} />
    </span>
  );
}

function CallBody({ id, item }: { readonly id: string; readonly item: Item }) {
  const t = useT();
  if (item.type === 'fileChange') {
    return <FileChangeBody id={id} item={item} />;
  }
  const output = outputOf(item);
  return (
    <>
      {output === undefined ? null : (
        <pre
          className={`tool-output${item.status === 'failed' ? ' is-failed' : ''}`}
          aria-label={t('transcript.tool.output')}
          // The output scrolls inside its box: a keyboard user can reach it.
          tabIndex={0}
        >
          {lastLines(output, OUTPUT_PREVIEW_LINES)}
        </pre>
      )}
    </>
  );
}

/** A call's controls next to its line: open the file it read, open a memory's settings. */
function CallAside({ item }: { readonly id: string; readonly item: Item }) {
  const t = useT();
  const {
    actions: { openMemory, openFile },
    fileLinks,
  } = useTranscriptView();
  const rawPath = readPath(item);
  const offset = 'arguments' in item ? item.arguments.offset : undefined;
  const target =
    rawPath && fileLinks && projectPath(rawPath, fileLinks.root, fileLinks.directory)
      ? rawPath
      : undefined;
  // A `Memory` call links to the note on the settings window's memory page (T47).
  const memory =
    item.type === 'dynamicToolCall' && item.tool === 'Memory' && openMemory !== undefined
      ? memoryNoteOf(item)
      : null;
  if (!(target && openFile) && memory === null) return null;
  return (
    <>
      {target && openFile ? (
        <IconButton
          label={t('files.tree.openPath', { path: revealBidi(target) })}
          size="xs"
          className="tool-open-file"
          data-testid="read-file-path"
          onClick={() => {
            openFile(
              target,
              typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0
                ? offset
                : undefined,
            );
          }}
        >
          <ExternalGlyph />
        </IconButton>
      ) : null}
      {memory !== null && openMemory !== undefined ? (
        <button
          type="button"
          className="button button-small button-ghost tool-call-link"
          data-testid="memory-open-settings"
          onClick={() => {
            openMemory(memory.note);
          }}
        >
          {t('transcript.memory.openSettings')}
        </button>
      ) : null}
    </>
  );
}

/** One call inside an expanded group. */
const ToolCall = memo(function ToolCall({ id }: { readonly id: string }) {
  const row = useTranscriptRow(id);
  const outcome = useOutcome();
  const detail = useDetail();
  const [open, setOpen] = useExpanded(`call:${id}`, false);
  if (row?.kind !== 'item') {
    return null;
  }
  const { item } = row;
  switch (item.type) {
    case 'fileChange':
      return <FileChangeCard id={id} item={item} />;
    case 'commandExecution':
      return <BashCard id={id} item={item} startedAt={row.startedAt} />;
    case 'webSearch':
      return <WebSearchCard id={id} item={item} />;
    case 'reasoning':
      // The normal view shows no thinking (T29).
      return detail === 'normal' ? null : (
        <ThinkingRow id={id} item={item} startedAt={row.startedAt} endedAt={row.endedAt} />
      );
    default:
      break;
  }
  return (
    <div className="tool-call" data-testid="tool-call" data-row-id={id} data-status={item.status}>
      <StepRow
        verb={<PartText part={{ verb: verbOf(item), count: 1, target: targetOf(item) }} />}
        state={stepState(item.status)}
        outcome={outcome(item.status)}
        expanded={hasBody(item) ? open : undefined}
        onToggle={() => {
          setOpen(!open);
        }}
        aside={<CallAside id={id} item={item} />}
        notes={
          'review' in item && item.review != null ? <ReviewNote review={item.review} /> : undefined
        }
      >
        <CallBody id={id} item={item} />
      </StepRow>
      <ReadImage item={item} />
    </div>
  );
});

/** The note a `Memory` call names (`undefined` for the index), for "Open in settings". */
function memoryNoteOf(item: Extract<Item, { type: 'dynamicToolCall' }>): {
  note: string | undefined;
} {
  const name = item.arguments.name;
  const note = typeof name === 'string' ? name.trim() : '';
  // A deleted note has nothing to show; the page opens on the list.
  return { note: note === '' || item.arguments.action === 'delete' ? undefined : note };
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\n$/u, '').split('\n');
  return lines.length <= count ? lines.join('\n') : lines.slice(-count).join('\n');
}

/** The first line of a command, for its row. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text;
  return line === text ? text : `${line} …`;
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
  const { t, format } = useApp();
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
  // T32: the command runs on as a background task (asked for, or moved by its timeout).
  const task = execution?.task ?? undefined;
  const [open, setOpen] = useExpanded(id, false);
  const output = item.output ?? '';
  const outcome = execution?.outcome ?? (item.status === 'completed' ? 'success' : 'failure');
  const background = task !== undefined && item.status === 'completed';
  const finished = item.status === 'completed' || item.status === 'failed';
  const state: StepState = running
    ? 'busy'
    : finished
      ? outcome === 'success'
        ? 'done'
        : 'failed'
      : stepState(item.status);
  // The outcome word: none for a success; the failure, the background or the stop otherwise.
  let stateText: string | undefined;
  if (running) stateText = undefined;
  else if (background) stateText = t('transcript.bash.background');
  else if (finished) stateText = outcome === 'success' ? undefined : t('transcript.bash.failure');
  else stateText = t(STATUS_MESSAGE[item.status]);
  const notes: ReactNode[] = [];
  if (item.review != null) notes.push(<ReviewNote key="review" review={item.review} />);
  if (task !== undefined) {
    notes.push(
      <div key="task" className="step-note" data-testid="bash-task">
        {task.reason === 'timeout'
          ? t('transcript.bash.movedToBackground', {
              seconds: Math.round((execution?.timeoutMs ?? 0) / 1000),
              task: task.taskId,
            })
          : t('transcript.bash.inBackground', { task: task.taskId })}
      </div>,
    );
  } else if (execution?.timedOut === true) {
    notes.push(
      <div key="timeout" className="step-note is-warning">
        {t('transcript.bash.timedOut', { seconds: Math.round(execution.timeoutMs / 1000) })}
      </div>,
    );
  }
  if (execution?.truncated === true && fullOutputPath !== undefined) {
    notes.push(
      <div key="truncated" className="step-note" data-testid="bash-truncated">
        {t('transcript.bash.truncated', { path: fullOutputPath })}
      </div>,
    );
  }
  if (cwdReset !== undefined) {
    notes.push(
      <div key="cwd" className="step-note">
        {t('transcript.bash.cwdReset', { path: cwdReset.resetTo, reason: cwdReset.reason })}
      </div>,
    );
  }
  return (
    <div
      className={`row row-bash is-${item.status}`}
      data-testid="bash-card"
      data-row-id={id}
      data-status={item.status}
      data-outcome={running ? 'running' : outcome}
    >
      <StepRow
        verb={
          running ? (
            <span data-testid="bash-state">{t('transcript.tool.status.inProgress')}</span>
          ) : (
            t('transcript.bash.ran')
          )
        }
        meta={<span className="step-code">{firstLine(item.command)}</span>}
        metaTitle={item.command}
        state={state}
        outcome={
          stateText === undefined ? undefined : <span data-testid="bash-state">{stateText}</span>
        }
        trail={
          <Segments>
            {[
              running && elapsed >= BASH_TIMER_AFTER_MS ? (
                <span key="elapsed" data-testid="bash-elapsed">
                  {elapsedText(elapsed)}
                </span>
              ) : null,
              exitCode === undefined ? null : (
                <span key="exit" data-testid="bash-exit">
                  {t('transcript.bash.exit', { code: exitCode })}
                  {meaning === undefined ? '' : ` · ${meaning}`}
                </span>
              ),
              signal === undefined ? null : (
                <span key="signal">{t('transcript.bash.signal', { signal })}</span>
              ),
              execution === undefined ? null : (
                <span key="duration">
                  {t('transcript.bash.duration', {
                    seconds: format.number(execution.durationMs / 1000, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                  })}
                </span>
              ),
            ]}
          </Segments>
        }
        expanded={open}
        onToggle={() => {
          setOpen(!open);
        }}
        lineTestId="bash-output-toggle"
        notes={notes.length === 0 ? undefined : notes}
      >
        <div className="bash-body">
          <div className="bash-command-card">
            {execution === undefined ? null : (
              <div className="bash-cwd" data-testid="bash-cwd" title={execution.cwd}>
                {t('transcript.bash.cwd', { cwd: execution.cwd })}
              </div>
            )}
            <pre className="bash-command" data-testid="bash-command">
              <span className="bash-prompt" aria-hidden="true">
                ${' '}
              </span>
              <CommandText text={item.command} />
            </pre>
          </div>
          {output === '' ? null : (
            <pre
              className={`tool-output${state === 'failed' ? ' is-failed' : ''}`}
              data-testid="bash-output"
              tabIndex={0}
            >
              {output.replace(/\n$/u, '')}
            </pre>
          )}
        </div>
      </StepRow>
      {running && !open && output !== '' ? (
        <pre className="tool-output is-live" data-testid="bash-output">
          {lastLines(output, LIVE_OUTPUT_LINES)}
        </pre>
      ) : null}
    </div>
  );
}

/** A file change with Core's diff: a step that opens on its diff. */
export function FileChangeCard({
  id,
  item,
}: {
  readonly id: string;
  readonly item: FileChangeItem;
}) {
  const t = useT();
  const outcome = useOutcome();
  const diff = item.diff ?? undefined;
  const [open, setOpen] = useExpanded(`change:${id}`, true);
  return (
    <div
      className={`row-file-change is-${item.status}`}
      data-testid="file-change-card"
      data-row-id={id}
      data-status={item.status}
    >
      <StepRow
        verb={<PartText part={{ verb: 'edit', count: 1, target: baseName(item.path) }} />}
        state={stepState(item.status)}
        outcome={diff?.created === true ? t('transcript.file.created') : outcome(item.status)}
        trail={
          diff === undefined ? undefined : (
            <DiffPill added={diff.added} removed={diff.removed} testId="file-change-lines" />
          )
        }
        expanded={open}
        onToggle={() => {
          setOpen(!open);
        }}
        notes={item.review == null ? undefined : <ReviewNote review={item.review} />}
      >
        <FileChangeBody id={id} item={item} />
      </StepRow>
    </div>
  );
}

/** A file change's path and Core's diff. */
function FileChangeBody({ id, item }: { readonly id: string; readonly item: FileChangeItem }) {
  const t = useT();
  const diff = item.diff ?? undefined;
  const { openFile } = useTranscriptView().actions;
  const [all, setAll] = useExpanded(`diff:${id}`, false);
  return (
    <div className="file-change-body" data-testid="file-change-body">
      <div className="file-change-head">
        {openFile ? (
          <button
            type="button"
            className="file-change-path file-path-action"
            data-testid="file-change-path"
            title={item.path}
            onClick={() => {
              openFile(item.path);
            }}
          >
            {revealBidi(item.path)}
          </button>
        ) : (
          <span className="file-change-path" data-testid="file-change-path" title={item.path}>
            {revealBidi(item.path)}
          </span>
        )}
      </div>
      {diff === undefined ? (
        item.status === 'inProgress' ? null : (
          <div className="step-note">{t('transcript.file.noDiff')}</div>
        )
      ) : diff.degraded === true || diff.hunks.length === 0 ? (
        <div className="step-note">{t('transcript.file.degraded')}</div>
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

/** A diff line's sign: `+` or `−` named "Added" or "Removed" for screen readers (R5), which
 * otherwise read both kinds of line alike; context lines have none. */
export function DiffSign({ kind }: { readonly kind: DiffHunk['lines'][number]['kind'] }) {
  const t = useT();
  if (kind === 'added' || kind === 'removed') {
    return (
      <span className="diff-sign" role="img" aria-label={t(`diff.${kind}`)}>
        {kind === 'added' ? '+' : '−'}
      </span>
    );
  }
  return (
    <span className="diff-sign" aria-hidden="true">
      {' '}
    </span>
  );
}

export function DiffView({
  hunks,
  limit,
  onShowAll,
}: {
  readonly hunks: readonly DiffHunk[];
  readonly limit: number;
  readonly onShowAll: () => void;
}) {
  const t = useT();
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
                <DiffSign kind={line.kind} />
                {revealBidi(line.text)}
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
        <button type="button" className="diff-more" data-testid="diff-show-all" onClick={onShowAll}>
          {t('transcript.diff.showMore', { count: total - shown })}
        </button>
      ) : null}
    </div>
  );
}
