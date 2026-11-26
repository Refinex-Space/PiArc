// The Git tool's Commit view (ADR-0084, SPEC B1–B4): the sync bar (branch, ahead and behind,
// fetch, pull, push), the state of a merge or rebase in progress, the changed files with
// tri-state staging checkboxes, the commit message with generation and amend, and the selected
// file's staged and unstaged hunks with their stage, unstage and rollback buttons. Below 560 px
// the diff replaces the list with a back button. Every write goes through `actions.ts`.
import type { FileDiff } from '@piarc/protocol';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { TreeTypeIcon } from '../../files/tree-row.js';
import { MenuPopup, useMenu, type MenuItem } from '../../shell/Menu.js';
import { PanelEmpty } from '../../shell/PanelEmpty.js';
import { useUi } from '../../shell/ui.js';
import {
  CheckIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  FetchIcon,
  GenerateIcon,
  GitBranchIcon,
  GitCommitIcon,
  MinusIcon,
  PullIcon,
  PushIcon,
  RollbackIcon,
  SpinnerGlyph,
  StopGlyph,
} from '../../shell/icons.js';
import { StashButtonDialog } from './LogView.js';
import { useAutoFetchFailure } from './auto-fetch.js';
import { revealBidi } from '../../transcript/reveal.js';
import { isImeComposing } from '../../composer/ime-guard.js';
import { pushNotice, useGitActions, useGitBoard, type GitActions } from './actions.js';
import { BranchPopup } from './BranchPopup.js';
import { Divider } from './FileColumn.js';
import { ActionHunk, asChangesFile, type DiffDisplay } from './GitDiff.js';
import { readDisplay } from './model.js';
import {
  commitMessageOf,
  fileStagesOf,
  gitCall,
  lastCommitOf,
  type FileStages,
  type FileStatus,
  type Repository,
  type StatusFile,
} from './protocol.js';
import { newOpId, type GitSnapshot } from './state.js';

/** The left column of the Commit view. */
const COMMIT_COLUMN = { min: 200, max: 520, initial: 300 } as const;
/** Below this width the view shows one column. */
const ONE_COLUMN_WIDTH = 560;
/** The first line of a message is long past this. */
const SUBJECT_LIMIT = 72;
const MESSAGE_KEY = 'piarc.git.message.';
const COLUMN_KEY = 'piarc.git.commitColumn.v1';

type Check = true | false | 'mixed';

/** The status letter of a side of a file. */
export function letterOf(status: FileStatus | undefined): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typeChanged':
      return 'T';
    case 'untracked':
      return '?';
    case 'conflicted':
      return 'U';
    default:
      return '';
  }
}

export type FileGroup = 'conflicts' | 'changes' | 'untracked';

export function groupOf(file: StatusFile): FileGroup {
  if (
    file.conflict !== undefined ||
    file.staged === 'conflicted' ||
    file.unstaged === 'conflicted'
  ) {
    return 'conflicts';
  }
  return file.unstaged === 'untracked' && file.staged === undefined ? 'untracked' : 'changes';
}

/** Staged in full, in part, or not at all. */
export function checkOf(file: StatusFile): Check {
  if (file.staged === undefined) return false;
  return file.unstaged === undefined ? true : 'mixed';
}

/** A group's checkbox: all staged, some, or none. */
export function groupCheck(files: readonly StatusFile[]): Check {
  const checks = files.map(checkOf);
  if (checks.length > 0 && checks.every((c) => c === true)) return true;
  return checks.some((c) => c !== false) ? 'mixed' : false;
}

/** What the staged files are, to tell whether a generated message is still current. */
function stagedKey(files: readonly StatusFile[]): string {
  return files
    .filter((f) => f.staged !== undefined)
    .map((f) => `${f.path}:${f.staged ?? ''}:${String(f.added ?? '')}:${String(f.removed ?? '')}`)
    .join('\n');
}

function readMessage(sessionId: string): string {
  try {
    return window.localStorage.getItem(MESSAGE_KEY + sessionId) ?? '';
  } catch {
    return '';
  }
}

function saveMessage(sessionId: string, message: string): void {
  try {
    if (message === '') window.localStorage.removeItem(MESSAGE_KEY + sessionId);
    else window.localStorage.setItem(MESSAGE_KEY + sessionId, message);
  } catch {
    // A convenience only.
  }
}

function readColumn(): number {
  try {
    const value = Number(window.localStorage.getItem(COLUMN_KEY));
    return Number.isFinite(value) && value >= COMMIT_COLUMN.min && value <= COMMIT_COLUMN.max
      ? value
      : COMMIT_COLUMN.initial;
  } catch {
    return COMMIT_COLUMN.initial;
  }
}

function CheckBox({
  checked,
  label,
  disabled,
  onToggle,
  testId,
}: {
  readonly checked: Check;
  readonly label: string;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      className="git-check"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {/* A 16 px box in a 24 px target (WCAG 2.5.8). */}
      <span className="git-check-box" aria-hidden="true">
        {checked === true ? (
          <CheckIcon size={12} />
        ) : checked === 'mixed' ? (
          <MinusIcon size={12} />
        ) : null}
      </span>
    </button>
  );
}

export function CommitView({
  sessionId,
  git,
  width,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly width: number;
}) {
  const t = useT();
  const actions = useGitActions(sessionId);
  const status = git.status.value;
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [column, setColumnState] = useState(readColumn);
  const setColumn = (next: number) => {
    setColumnState(next);
    try {
      window.localStorage.setItem(COLUMN_KEY, String(next));
    } catch {
      // A convenience only.
    }
  };
  const files = useMemo(() => status?.files ?? [], [status]);
  useEffect(() => {
    if (selected !== undefined && !files.some((f) => f.path === selected)) setSelected(undefined);
  }, [files, selected]);
  if (status === undefined) return null;
  const repo = status.repository;
  const oneColumn = width > 0 && width < ONE_COLUMN_WIDTH;
  const file = files.find((f) => f.path === selected);
  const list = (
    <div className="git-commit-column" style={oneColumn ? undefined : { width: column }}>
      <StateBar sessionId={sessionId} repo={repo} files={files} actions={actions} />
      <CommitFiles
        files={files}
        truncated={status.truncated}
        writable={repo.writable}
        selected={selected}
        onSelect={setSelected}
        actions={actions}
      />
      <MessageBox sessionId={sessionId} git={git} repo={repo} files={files} actions={actions} />
    </div>
  );
  const diff =
    file === undefined ? (
      <PanelEmpty
        title={t(files.length === 0 ? 'git.commit.clean' : 'git.commit.pickFile')}
        icon={<GitCommitIcon size={20} />}
        testId="git-commit-nofile"
      />
    ) : (
      <StagesView
        key={file.path}
        sessionId={sessionId}
        file={file}
        writable={repo.writable}
        actions={actions}
        fingerprint={status.fingerprint}
      />
    );
  return (
    <div className="git-commit" data-testid="git-commit-view" data-columns={oneColumn ? 1 : 2}>
      <SyncBar sessionId={sessionId} git={git} repo={repo} actions={actions} />
      <div className="git-commit-body">
        {oneColumn ? (
          file === undefined ? (
            list
          ) : (
            <div className="git-commit-detail">
              <button
                type="button"
                className="git-back"
                data-testid="git-commit-back"
                onClick={() => {
                  setSelected(undefined);
                }}
              >
                <ChevronLeftIcon size={12} />
                {t('git.commit.back')}
              </button>
              {diff}
            </div>
          )
        ) : (
          <>
            {list}
            <Divider
              width={column}
              onWidth={setColumn}
              bounds={COMMIT_COLUMN}
              label={t('git.commit.resize')}
              testId="git-commit-divider"
            />
            <div className="git-commit-detail">{diff}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** The branch button, ahead and behind, fetch, pull and push, and progress of a running sync. */
function SyncBar({
  sessionId,
  git,
  repo,
  actions,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly actions: GitActions;
}) {
  const t = useT();
  const board = useGitBoard(sessionId);
  const [branches, setBranches] = useState<HTMLElement | undefined>(undefined);
  const [stashing, setStashing] = useState(false);
  const autoFetchFailure = useAutoFetchFailure(repo.root);
  const dirty = (git.status.value?.files.length ?? 0) > 0;
  const running = [...board.running.entries()].filter(([, label]) => label !== '');
  const busy = board.running.size > 0;
  const branch = repo.detached ? `HEAD ${(repo.head ?? '').slice(0, 7)}` : (repo.branch ?? '');
  const noRemote = repo.remotes.length === 0;
  return (
    <div className="git-sync">
      <button
        type="button"
        className="git-branch-button"
        data-testid="git-branch-button"
        aria-haspopup="dialog"
        aria-expanded={branches !== undefined}
        aria-label={t('git.branch.button', { branch })}
        onClick={(event) => {
          setBranches(event.currentTarget);
        }}
      >
        <GitBranchIcon size={12} />
        <span className="git-branch-name">{revealBidi(branch)}</span>
        {repo.upstream === undefined ? null : (
          <span
            className="git-ahead-behind"
            aria-label={t('git.branch.aheadBehind', { ahead: repo.ahead, behind: repo.behind })}
          >
            {repo.ahead > 0 ? `↑${String(repo.ahead)}` : ''}
            {repo.behind > 0 ? ` ↓${String(repo.behind)}` : ''}
          </span>
        )}
        <ChevronDownIcon size={12} />
      </button>
      <span className="git-sync-spacer" />
      <IconButton
        label={
          autoFetchFailure === undefined
            ? t('git.sync.fetch')
            : t('git.sync.autoFetchFailed', { reason: autoFetchFailure })
        }
        size="sm"
        disabled={busy || noRemote || !repo.writable}
        data-testid="git-fetch"
        onClick={() => void actions.fetch()}
      >
        <FetchIcon />
      </IconButton>
      <IconButton
        label={
          repo.behind > 0 ? t('git.sync.pullCount', { count: repo.behind }) : t('git.sync.pull')
        }
        size="sm"
        disabled={busy || repo.upstream === undefined || !repo.writable}
        data-testid="git-pull"
        onClick={() => void actions.pull()}
      >
        <PullIcon />
      </IconButton>
      <IconButton
        label={repo.ahead > 0 ? t('git.sync.pushCount', { count: repo.ahead }) : t('git.sync.push')}
        size="sm"
        disabled={busy || noRemote || repo.detached || !repo.writable}
        data-testid="git-push"
        onClick={() => void actions.push()}
      >
        <PushIcon />
      </IconButton>
      <IconButton
        label={t('git.sync.stash')}
        size="sm"
        disabled={busy || !dirty || !repo.writable}
        data-testid="git-stash"
        onClick={() => {
          setStashing(true);
        }}
      >
        <ArchiveIcon />
      </IconButton>
      {running.length === 0 ? null : (
        <div className="git-progress" role="status" data-testid="git-progress">
          {running.map(([opId, label]) => {
            const progress = git.progress.get(opId);
            return (
              <div key={opId} className="git-progress-row">
                <SpinnerGlyph size={12} />
                <span className="git-progress-text">
                  {label}
                  {progress === undefined
                    ? ''
                    : ` · ${progress.phase}${progress.percent === undefined ? '' : ` ${String(progress.percent)}%`}`}
                </span>
                <button
                  type="button"
                  className="git-link-button"
                  data-testid="git-cancel"
                  onClick={() => {
                    actions.cancel(opId);
                  }}
                >
                  {t('git.sync.cancel')}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {!stashing ? null : (
        <StashButtonDialog
          sessionId={sessionId}
          actions={actions}
          onClose={() => {
            setStashing(false);
          }}
        />
      )}
      {branches === undefined ? null : (
        <BranchPopup
          sessionId={sessionId}
          git={git}
          repo={repo}
          anchor={branches}
          actions={actions}
          onClose={() => {
            setBranches(undefined);
          }}
        />
      )}
    </div>
  );
}

/** A merge, rebase, cherry-pick or revert in progress: what it is and how to go on. */
function StateBar({
  sessionId,
  repo,
  files,
  actions,
}: {
  readonly sessionId: string;
  readonly repo: Repository;
  readonly files: readonly StatusFile[];
  readonly actions: GitActions;
}) {
  const t = useT();
  const board = useGitBoard(sessionId);
  const state = repo.state;
  if (state === undefined || state.kind === 'clean') return null;
  const conflicts = files.filter((f) => groupOf(f) === 'conflicts').length;
  const text = (() => {
    switch (state.kind) {
      case 'merging':
        return t('git.state.merging', { source: state.source ?? '' });
      case 'rebasing':
        return state.step !== undefined && state.total !== undefined
          ? t('git.state.rebasingStep', {
              onto: state.onto ?? '',
              step: state.step,
              total: state.total,
            })
          : t('git.state.rebasing', { onto: state.onto ?? '' });
      case 'cherryPicking':
        return t('git.state.cherryPicking', { commit: (state.commit ?? '').slice(0, 7) });
      case 'reverting':
        return t('git.state.reverting', { commit: (state.commit ?? '').slice(0, 7) });
    }
  })();
  const busy = board.running.size > 0 || !repo.writable;
  return (
    <div className="git-state" role="status" data-testid="git-state" data-state={state.kind}>
      <p className="git-state-text">
        {revealBidi(text)}
        {conflicts > 0 ? (
          <span className="git-state-conflicts">
            {t('git.state.conflicts', { count: conflicts })}
          </span>
        ) : null}
      </p>
      <div className="git-state-actions">
        <button
          type="button"
          className="button button-small"
          disabled={busy || conflicts > 0}
          data-testid="git-continue"
          onClick={() => void actions.sequence('continue')}
        >
          {t('git.state.continue')}
        </button>
        {state.kind !== 'rebasing' ? null : (
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            data-testid="git-skip"
            onClick={() => void actions.sequence('skip')}
          >
            {t('git.state.skip')}
          </button>
        )}
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          data-testid="git-abort"
          onClick={() => void actions.sequence('abort')}
        >
          {t('git.state.abort')}
        </button>
      </div>
    </div>
  );
}

/** The changed files by group, each with a tri-state staging checkbox. */
function CommitFiles({
  files,
  truncated,
  writable,
  selected,
  onSelect,
  actions,
}: {
  readonly files: readonly StatusFile[];
  readonly truncated: boolean;
  readonly writable: boolean;
  readonly selected: string | undefined;
  readonly onSelect: (path: string | undefined) => void;
  readonly actions: GitActions;
}) {
  const t = useT();
  const menu = useMenu();
  const [menuFile, setMenuFile] = useState<StatusFile | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const groups = (['conflicts', 'changes', 'untracked'] as const)
    .map((group) => [group, files.filter((f) => groupOf(f) === group)] as const)
    .filter(([, members]) => members.length > 0);
  const toggle = (members: readonly StatusFile[], check: Check) => {
    const paths = members.map((f) => f.path);
    void (check === true ? actions.unstage(paths) : actions.stage(paths));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
    const focused = event.currentTarget.ownerDocument.activeElement;
    const at = rows.findIndex((r) => r === focused);
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : undefined;
    if (to !== undefined) {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    } else if (event.key === ' ' && at >= 0) {
      event.preventDefault();
      const path = rows[at]?.dataset.path;
      const file = files.find((f) => f.path === path);
      if (file !== undefined && writable) toggle([file], checkOf(file));
    }
  };
  const fileMenu = (file: StatusFile): MenuItem[] => {
    const group = groupOf(file);
    return [
      ...(group === 'conflicts'
        ? [
            {
              id: 'resolved',
              label: t('git.commit.markResolved'),
              testId: 'git-mark-resolved',
              run: () => void actions.markResolved([file.path]),
            },
          ]
        : []),
      ...(file.unstaged === undefined || file.unstaged === 'conflicted'
        ? []
        : [
            {
              id: 'stage',
              label: t('git.commit.stage'),
              run: () => void actions.stage([file.path]),
            },
          ]),
      ...(file.staged === undefined
        ? []
        : [
            {
              id: 'unstage',
              label: t('git.commit.unstage'),
              run: () => void actions.unstage([file.path]),
            },
          ]),
      ...(group === 'untracked'
        ? []
        : [
            {
              id: 'rollback',
              label: t('git.file.rollback'),
              danger: true,
              testId: 'git-commit-rollback',
              run: () => void actions.rollback([file.path]),
            },
          ]),
    ];
  };
  if (files.length === 0) {
    return (
      <p className="git-note git-commit-clean" data-testid="git-commit-clean">
        {t('git.commit.nothing')}
      </p>
    );
  }
  return (
    <div
      className="git-commit-files"
      ref={list}
      role="group"
      aria-label={t('git.commit.files')}
      onKeyDown={onKeyDown}
    >
      {truncated ? <p className="git-banner">{t('git.commit.truncated')}</p> : null}
      {groups.map(([group, members]) => {
        const check = groupCheck(members);
        return (
          <div
            key={group}
            className="git-commit-group"
            role="group"
            aria-label={t(`git.commit.group.${group}`)}
          >
            <div className="git-commit-group-head">
              {group === 'conflicts' ? null : (
                <CheckBox
                  checked={check}
                  label={t('git.commit.stageGroup', { group: t(`git.commit.group.${group}`) })}
                  disabled={!writable}
                  testId={`git-group-check-${group}`}
                  onToggle={() => {
                    toggle(members, check);
                  }}
                />
              )}
              <span className="git-commit-group-name">{t(`git.commit.group.${group}`)}</span>
              <span className="git-commit-group-count">{members.length}</span>
            </div>
            {members.map((file) => {
              const slash = file.path.lastIndexOf('/');
              const name = file.path.slice(slash + 1);
              const folder = slash < 0 ? '' : file.path.slice(0, slash);
              const letter = letterOf(
                group === 'conflicts' ? 'conflicted' : (file.unstaged ?? file.staged),
              );
              return (
                <div
                  key={file.path}
                  className="git-cfile"
                  data-path={file.path}
                  data-selected={selected === file.path || undefined}
                  data-testid="git-commit-file"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenuFile(file);
                    menu.openAt(event.clientX, event.clientY);
                  }}
                >
                  {group === 'conflicts' ? (
                    <span className="git-check-spacer" />
                  ) : (
                    <CheckBox
                      checked={checkOf(file)}
                      label={t('git.commit.stageFile', { path: revealBidi(file.path) })}
                      disabled={!writable}
                      testId="git-file-check"
                      onToggle={() => {
                        toggle([file], checkOf(file));
                      }}
                    />
                  )}
                  {/* The row's own button selects the file; the checkbox beside it stages. */}
                  <button
                    type="button"
                    className="git-cfile-select"
                    aria-current={selected === file.path ? 'true' : undefined}
                    tabIndex={
                      selected === file.path || (selected === undefined && file === files[0])
                        ? 0
                        : -1
                    }
                    data-row
                    data-path={file.path}
                    onClick={() => {
                      onSelect(file.path);
                    }}
                  >
                    <span
                      className={`git-letter is-${group === 'conflicts' ? 'conflicted' : (file.unstaged ?? file.staged ?? 'modified')}`}
                      aria-hidden="true"
                    >
                      {letter}
                    </span>
                    <TreeTypeIcon name={name} directory={false} open={false} />
                    <span className="git-cfile-name" data-tooltip={revealBidi(file.path)}>
                      <span className="git-file-base">{revealBidi(name)}</span>
                      {folder === '' ? null : (
                        <span className="git-file-folder">{revealBidi(folder)}</span>
                      )}
                    </span>
                    {file.added === undefined ? null : (
                      <span className="git-counts">
                        <span className="diff-added">+{file.added}</span>{' '}
                        <span className="diff-removed">−{file.removed ?? 0}</span>
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
      {menu.open === null || menuFile === undefined ? null : (
        <MenuPopup
          items={fileMenu(menuFile)}
          at={menu.open}
          onClose={menu.close}
          label={t('git.file.menu')}
          testId="git-commit-file-menu"
        />
      )}
    </div>
  );
}

/** The commit message: draft per session, generation, amend, commit and commit-and-push. */
function MessageBox({
  sessionId,
  git,
  repo,
  files,
  actions,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly files: readonly StatusFile[];
  readonly actions: GitActions;
}) {
  const { t, preferences, keyPlatform } = useApp();
  const board = useGitBoard(sessionId);
  const [message, setMessageState] = useState(() => readMessage(sessionId));
  const [amend, setAmend] = useState(false);
  const [pushedHead, setPushedHead] = useState(false);
  const [generating, setGenerating] = useState<string | undefined>(undefined);
  const [generatedFor, setGeneratedFor] = useState<string | undefined>(undefined);
  const [withheld, setWithheld] = useState<readonly string[]>([]);
  /** The model that wrote the message when it was not the chosen auxiliary model. */
  const [fallbackModel, setFallbackModel] = useState<string | undefined>(undefined);
  const [confirmDetached, setConfirmDetached] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const menu = useMenu();
  const setMessage = useCallback(
    (next: string) => {
      setMessageState(next);
      saveMessage(sessionId, next);
    },
    [sessionId],
  );
  const staged = files.some((f) => f.staged !== undefined);
  const conflicts = files.some((f) => groupOf(f) === 'conflicts');
  const key = stagedKey(files);
  const emptyRepo = repo.head === undefined;
  const busy = board.running.size > 0;
  const subject = message.split('\n')[0] ?? '';
  const reason = !repo.writable
    ? t('git.commit.why.untrusted')
    : conflicts
      ? t('git.commit.why.conflicts')
      : !staged && !amend
        ? t('git.commit.why.nothingStaged')
        : message.trim() === ''
          ? t('git.commit.why.noMessage')
          : busy
            ? t('git.commit.why.busy')
            : undefined;
  const generateReason = !repo.writable
    ? t('git.commit.why.untrusted')
    : !staged && !amend
      ? t('git.commit.why.nothingStaged')
      : undefined;
  /** Replaces the text as typed, so Mod+Z brings the previous message back. */
  const replaceText = (text: string) => {
    const el = box.current;
    if (el !== null) {
      el.focus();
      el.select();
      // Chromium's insertText keeps the textarea's native undo stack; setting the value does not.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- native undo for one plain-text edit
      if (el.ownerDocument.execCommand('insertText', false, text)) return;
    }
    setMessage(text);
  };
  const generate = async () => {
    const opId = newOpId();
    setGenerating(opId);
    setWithheld([]);
    const startedFor = key;
    const instructions =
      preferences.git.commitInstructions.trim() === ''
        ? t('git.instructions.default')
        : preferences.git.commitInstructions;
    const reply = await gitCall(
      sessionId,
      amend
        ? { op: 'commitMessage', instructions, amend: true }
        : { op: 'commitMessage', instructions },
      commitMessageOf,
      opId,
    );
    setGenerating(undefined);
    if (reply.ok) {
      replaceText(reply.value.text);
      setGeneratedFor(startedFor);
      setWithheld(reply.value.withheld);
      setFallbackModel(reply.value.fallback ? reply.value.model : undefined);
    } else {
      actions.report(reply.failure);
    }
  };
  const onAmend = (on: boolean) => {
    setAmend(on);
    if (!on) return;
    void gitCall(sessionId, { op: 'lastCommit' }, lastCommitOf).then((reply) => {
      if (!reply.ok) return;
      setPushedHead(reply.value.pushed);
      if (message.trim() === '' && reply.value.message !== undefined)
        setMessage(reply.value.message);
    });
  };
  const commit = async (push: boolean) => {
    if (reason !== undefined) return;
    if (repo.detached && !confirmDetached) {
      setConfirmDetached(true);
      return;
    }
    setConfirmDetached(false);
    const reply = await actions.run(
      amend ? { op: 'commit', message, amend: true } : { op: 'commit', message },
      { label: t('git.progress.commit') },
    );
    if (!reply.ok) return;
    setMessage('');
    setAmend(false);
    setGeneratedFor(undefined);
    setWithheld([]);
    setFallbackModel(undefined);
    pushNotice(sessionId, {
      tone: 'info',
      text: t('git.notice.committed', {
        short: (reply.value.head ?? '').slice(0, 7),
        subject: reply.value.subject ?? subject,
      }),
      actions: [],
    });
    if (push) await actions.push();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    const mod = keyPlatform === 'mac' ? event.metaKey : event.ctrlKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      void commit(event.altKey && repo.remotes.length > 0);
    }
  };
  const stale = generatedFor !== undefined && generatedFor !== key && generating === undefined;
  return (
    <div className="git-message" data-testid="git-message">
      <div className="git-message-field">
        <textarea
          ref={box}
          className="git-message-input"
          data-testid="git-commit-message"
          aria-label={t('git.commit.message')}
          placeholder={t('git.commit.placeholder')}
          value={message}
          readOnly={generating !== undefined}
          aria-busy={generating !== undefined}
          rows={4}
          spellCheck={false}
          onChange={(event) => {
            setMessage(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {generating === undefined ? (
          <IconButton
            label={generateReason ?? t('git.commit.generate')}
            size="xs"
            className="git-generate"
            disabled={generateReason !== undefined}
            data-testid="git-generate"
            onClick={() => void generate()}
          >
            <GenerateIcon />
          </IconButton>
        ) : (
          <IconButton
            label={t('git.commit.stopGenerating')}
            size="xs"
            className="git-generate is-running"
            data-testid="git-generate-stop"
            onClick={() => {
              void window.piarc.cancelGit(generating);
              setGenerating(undefined);
            }}
          >
            <StopGlyph />
          </IconButton>
        )}
      </div>
      <div className="git-message-meta">
        {generating === undefined ? null : (
          <span className="git-note" role="status">
            <SpinnerGlyph size={12} /> {t('git.commit.generating')}
          </span>
        )}
        {subject.length > SUBJECT_LIMIT ? (
          <span className="git-subject-long" data-testid="git-subject-long">
            {t('git.commit.subjectLong', { count: subject.length, limit: SUBJECT_LIMIT })}
          </span>
        ) : null}
        {stale ? (
          <span className="git-note" data-testid="git-generated-stale">
            {t('git.commit.generatedStale')}{' '}
            <button type="button" className="git-link-button" onClick={() => void generate()}>
              {t('git.commit.regenerate')}
            </button>
          </span>
        ) : null}
        {fallbackModel === undefined ? null : (
          <span className="git-note" data-testid="git-generated-fallback">
            {t('git.commit.fallbackModel', { model: fallbackModel })}
          </span>
        )}
        {withheld.length === 0 ? null : (
          <span
            className="git-note"
            data-testid="git-withheld"
            data-tooltip={withheld.map((w) => revealBidi(w)).join('\n')}
          >
            {t('git.commit.withheld', { count: withheld.length })}
          </span>
        )}
      </div>
      {emptyRepo ? null : (
        <label className="git-amend">
          <input
            type="checkbox"
            checked={amend}
            data-testid="git-amend"
            onChange={(event) => {
              onAmend(event.target.checked);
            }}
          />
          {t('git.commit.amend')}
          {amend && pushedHead ? (
            <span className="git-amend-warning">{t('git.commit.amendPushed')}</span>
          ) : null}
        </label>
      )}
      {confirmDetached ? (
        <p className="git-banner" role="alert" data-testid="git-detached-warning">
          {t('git.commit.detached')}
        </p>
      ) : null}
      <div className="git-commit-actions">
        <div className="git-split-button">
          <button
            type="button"
            className="button button-primary"
            data-testid="git-commit"
            disabled={reason !== undefined}
            data-tooltip={reason}
            aria-description={reason}
            onClick={() => void commit(false)}
          >
            {confirmDetached
              ? t('git.commit.anyway')
              : amend
                ? t('git.commit.amendButton')
                : t('git.commit.button')}
          </button>
          <button
            type="button"
            className="button button-primary git-split-more"
            aria-label={t('git.commit.moreActions')}
            aria-haspopup="menu"
            disabled={reason !== undefined || repo.remotes.length === 0}
            data-testid="git-commit-more"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              menu.openAt(rect.left, rect.top - 4, event.currentTarget);
            }}
          >
            <ChevronDownIcon size={12} />
          </button>
        </div>
        {git.status.value?.repository.protected === true ? (
          <span className="git-note">{t('git.commit.protectedBranch')}</span>
        ) : null}
      </div>
      {menu.open === null ? null : (
        <MenuPopup
          items={[
            {
              id: 'commit-push',
              label: t('git.commit.andPush'),
              shortcut: 'Mod+Alt+Enter',
              testId: 'git-commit-push',
              run: () => void commit(true),
            },
          ]}
          at={menu.open}
          onClose={menu.close}
          label={t('git.commit.moreActions')}
          testId="git-commit-menu"
        />
      )}
    </div>
  );
}

/** The selected file's staged and unstaged hunks, with their buttons. */
function StagesView({
  sessionId,
  file,
  writable,
  actions,
  fingerprint,
}: {
  readonly sessionId: string;
  readonly file: StatusFile;
  readonly writable: boolean;
  readonly actions: GitActions;
  readonly fingerprint: string;
}) {
  const t = useT();
  const { transcriptServices } = useUi();
  const [stages, setStages] = useState<FileStages | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  // Read again after every hunk operation: a refused one (`stale`) may leave the status alone.
  const [reads, setReads] = useState(0);
  const hunkOp = (request: Record<string, unknown> & { readonly op: string }) => {
    void actions.run(request).then(() => {
      setReads((n) => n + 1);
    });
  };
  const display: DiffDisplay = useMemo(() => {
    const prefs = readDisplay();
    return { split: false, wrap: prefs.wrap, wordDiff: prefs.wordDiff, hideWhitespace: false };
  }, []);
  useEffect(() => {
    let active = true;
    void gitCall(sessionId, { op: 'fileStages', path: file.path }, fileStagesOf).then((reply) => {
      if (!active) return;
      setFailed(!reply.ok);
      if (reply.ok) setStages(reply.value);
    });
    return () => {
      active = false;
    };
  }, [sessionId, file.path, fingerprint, reads]);
  if (stages === undefined) {
    return failed ? (
      <p className="git-note" role="alert">
        {t('git.failed')}
      </p>
    ) : (
      <p className="git-note">{t('git.diff.loading')}</p>
    );
  }
  const hunkRef = (stage: 'staged' | 'unstaged', index: number) => ({
    path: stages.path,
    stage,
    index,
    hash: (stage === 'staged' ? stages.stagedHashes : stages.hunkHashes)[index] ?? '',
    worktreeHash: stages.worktreeHash,
    indexOid: stages.indexOid,
  });
  const segment = (stage: 'staged' | 'unstaged', diff: FileDiff | undefined) => {
    if (diff === undefined) return null;
    const changes = asChangesFile(
      { path: stages.path, status: 'modified', binary: stages.binary, submodule: false },
      diff,
    );
    const hunks = diff.degraded ? [] : diff.hunks;
    const buttons = writable && stages.hunkActions;
    return (
      <section
        className="git-stage"
        data-testid={`git-stage-${stage}`}
        aria-label={t(`git.commit.segment.${stage}`)}
      >
        <h3 className="git-stage-title">
          {t(`git.commit.segment.${stage}`)}
          <span className="git-commit-group-count">{hunks.length}</span>
        </h3>
        {diff.degraded ? (
          <pre className="git-plain">{revealBidi(diff.unified)}</pre>
        ) : stages.binary ? (
          <p className="git-note">{t('git.label.binary')}</p>
        ) : (
          <div className={`git-diff${display.wrap ? ' is-wrapped' : ''}`}>
            <table className="git-table">
              {hunks.map((hunk, index) => (
                <Fragment key={`${String(hunk.newStart)}:${String(index)}`}>
                  <ActionHunk
                    hunk={hunk}
                    index={index}
                    file={changes}
                    highlight={transcriptServices.highlight}
                    display={display}
                    actions={
                      !buttons ? null : stage === 'staged' ? (
                        <button
                          type="button"
                          className="git-link-button"
                          data-testid="git-unstage-hunk"
                          onClick={() => {
                            hunkOp({ op: 'unstageHunk', hunk: hunkRef('staged', index) });
                          }}
                        >
                          {t('git.commit.unstageHunk')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="git-link-button"
                            data-testid="git-stage-hunk"
                            onClick={() => {
                              hunkOp({ op: 'stageHunk', hunk: hunkRef('unstaged', index) });
                            }}
                          >
                            {t('git.commit.stageHunk')}
                          </button>
                          <button
                            type="button"
                            className="git-link-button is-danger"
                            data-testid="git-rollback-hunk"
                            onClick={() => {
                              hunkOp({ op: 'rollbackHunk', hunk: hunkRef('unstaged', index) });
                            }}
                          >
                            <RollbackIcon size={12} />
                            {t('git.commit.rollbackHunk')}
                          </button>
                        </>
                      )
                    }
                  />
                </Fragment>
              ))}
            </table>
          </div>
        )}
      </section>
    );
  };
  return (
    <div className="git-stages" data-testid="git-stages" data-path={stages.path}>
      <header className="git-stages-head">
        <TreeTypeIcon
          name={stages.path.slice(stages.path.lastIndexOf('/') + 1)}
          directory={false}
          open={false}
        />
        <span className="git-file-base">{revealBidi(stages.path)}</span>
      </header>
      {stages.staged === undefined && stages.unstaged === undefined ? (
        <p className="git-note">
          {t(file.unstaged === 'untracked' ? 'git.commit.untrackedNote' : 'git.commit.noDiff')}
        </p>
      ) : null}
      {segment('staged', stages.staged)}
      {segment('unstaged', stages.unstaged)}
    </div>
  );
}
