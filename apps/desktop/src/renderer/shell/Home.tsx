// Before the first turn the environment card owns the workspace. The first prompt shares the
// conversation's editor, with trust and any explicitly selected session options applied first.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { isWorktreeName, type PermissionMode, type WorktreeOptions } from '../../shared/ipc.js';
import { useApp, useT } from '../app/app-context.js';
import { Composer, type ComposerSubmission } from '../composer/Composer.js';
import type { PaletteCommand } from '../composer/command-plugin.js';
import { parseCommandsList } from '../composer/commands-list.js';
import { coreMentions, draftOf } from '../composer/session-draft.js';
import { useStore, useWorkspaces } from '../store/hooks.js';
import { ComputerIcon, FolderIcon, GitBranchIcon } from './icons.js';
import { Mascot } from './Mascot.js';
import { ChoiceButton, type MenuItem } from './Menu.js';
import { keyOf, modelChoiceItems, useModelCatalog, type Effort } from './model-catalog.js';
import { permissionChoices } from './PermissionModeMenu.js';
import { reason } from './errors.js';
import { StartDeclined, startSession } from './start-session.js';
import { baseName, useUi } from './ui.js';
import { NoticeBar } from './NoticeBar.js';
import { ActivityMark } from '../transcript/rows/ActivityMark.js';

interface HomeProps {
  readonly workspace: string | undefined;
  readonly draft: string | undefined;
  readonly failure: string | undefined;
}

export function Home(props: HomeProps) {
  const workspaces = useWorkspaces();
  const workspace = props.workspace ?? workspaces[0]?.path;
  return (
    <HomeForm key={workspace ?? ''} {...props} workspace={workspace} workspaces={workspaces} />
  );
}

function HomeForm({
  workspace,
  draft,
  failure,
  workspaces,
}: HomeProps & { readonly workspaces: ReturnType<typeof useWorkspaces> }) {
  const { t, preferences } = useApp();
  const ui = useUi();
  const store = useStore();
  const label =
    workspaces.find((entry) => entry.path === workspace)?.displayName ??
    (workspace ? baseName(workspace) : t('home.chooseFolder'));
  const [catalogRequested, setCatalogRequested] = useState<string>();
  const ready = workspaces.some((w) => w.path === workspace && w.open);
  const { catalog, failure: catalogFailure } = useModelCatalog(
    ready || workspace === catalogRequested ? workspace : undefined,
    false,
  );
  const [modelKey, setModelKey] = useState('');
  const model = catalog?.models.find((m) => keyOf(m) === modelKey);
  const resolved =
    model ?? catalog?.models.find((m) => catalog.model && keyOf(m) === keyOf(catalog.model));
  const [effort, setEffort] = useState<Effort>();
  const [mode, setMode] = useState<PermissionMode>();
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);
  const [echo, setEcho] = useState<string>();
  const [error, setError] = useState(failure);
  const tree = useWorktreeChoice(workspace);
  const modelButton = useRef<HTMLButtonElement>(null);
  const [commands, setCommands] = useState<readonly PaletteCommand[]>([]);
  const commandsRequest = useRef(0);
  const mentions = useMemo(
    () => coreMentions(workspace, ui.composer?.maxSearchResults ?? 20),
    [workspace, ui.composer?.maxSearchResults],
  );
  // The shell opens a draft session for the tools in this folder; a worktree waits (ADR-0099).
  const { report: reportTools, sessionId: draftId } = ui.homeTools;
  useEffect(() => {
    reportTools(workspace, tree.enabled);
    return () => {
      reportTools(undefined, false);
    };
  }, [reportTools, workspace, tree.enabled]);

  const chooseWorkspace = (path: string) => {
    if (workspace !== path) ui.show({ kind: 'home', workspace: path });
  };
  const pickFolder = () => {
    void ui.openFolder().catch((cause: unknown) => {
      setError(reason(cause));
    });
  };
  const folderItems: MenuItem[] = workspaces.map((entry) => ({
    id: entry.path,
    label: entry.displayName,
    selected: entry.path === workspace,
    icon: <FolderIcon />,
    run: () => {
      chooseWorkspace(entry.path);
    },
  }));
  folderItems.push({
    id: 'open-folder',
    testId: 'home-open-folder',
    label: t('home.chooseFolder'),
    icon: <FolderIcon />,
    run: pickFolder,
  });
  const localLabel =
    tree.enabled && tree.branches !== false ? t('workbench.worktree') : t('workbench.local');
  const setupItems: MenuItem[] = [
    {
      id: 'local',
      label: t('workbench.local'),
      selected: !tree.enabled,
      icon: <ComputerIcon />,
      run: () => {
        tree.setEnabled(false);
      },
    },
    {
      id: 'worktree',
      label: t('home.worktree'),
      selected: tree.enabled,
      disabled: !workspace,
      icon: <GitBranchIcon />,
      run: () => {
        tree.setEnabled(true);
      },
    },
  ];
  const start = async (submission: ComposerSubmission): Promise<boolean> => {
    if (workspace === undefined || starting.current) return false;
    if (tree.enabled && tree.branches === false) {
      setError(t('home.worktreeNoRepo'));
      return false;
    }
    if (tree.options === 'invalid') {
      setError(t('home.worktreeInvalidName'));
      return false;
    }
    starting.current = true;
    setBusy(true);
    setError(undefined);
    // Once the session exists the view moves to it (its transcript holds the message); a later
    // failure brings the user back here, where the saved draft refills the input.
    const session = { created: false };
    try {
      if (!(await ui.ensureTrust(workspace, 'decide'))) return false;
      const message = draftOf(submission);
      const id = await startSession({
        api: window.piarc,
        store,
        workspace,
        ...(draftId !== undefined && !tree.enabled ? { sessionId: draftId } : {}),
        text: message.text,
        draft: message,
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        ...(effort && resolved?.efforts.includes(effort) ? { effort } : {}),
        ...(mode ? { mode } : {}),
        ...(tree.options ? { worktree: tree.options } : {}),
        clientId: crypto.randomUUID(),
        watch: (id) => ui.connection.watchSession(id),
        onStep: (step) => {
          if (step.kind === 'echo') {
            flushSync(() => {
              setEcho(step.text);
            });
            return;
          }
          if (step.unignoredWorktree === true)
            store.addLocalNotice({
              key: `gitignore:${workspace}`,
              type: 'gitignore',
              message: t('notice.gitignore', { workspace }),
              downloadUrl: undefined,
              workspace,
            });
          session.created = true;
          ui.show({ kind: 'session', id: step.sessionId });
        },
      });
      if (!session.created) ui.show({ kind: 'session', id });
      return true;
    } catch (cause) {
      // Declining Bypass permissions keeps the message here, unsent.
      if (cause instanceof StartDeclined) return false;
      const failed = t('home.failed', { reason: reason(cause) });
      if (session.created) ui.show({ kind: 'home', workspace, error: failed });
      else setError(failed);
      return false;
    } finally {
      starting.current = false;
      setBusy(false);
      setEcho(undefined);
    }
  };
  const loadCommands = () => {
    if (workspace === undefined) return;
    const seq = ++commandsRequest.current;
    window.piarc
      .listCommands(workspace, null)
      .then((json) => {
        if (seq === commandsRequest.current)
          setCommands(
            parseCommandsList(json).commands.filter(
              (cmd) => cmd.kind !== 'builtIn' || ['model', 'help'].includes(cmd.name),
            ),
          );
      })
      .catch((cause: unknown) => {
        if (seq === commandsRequest.current) setError(reason(cause));
      });
  };
  const shownEffort = effort ?? catalog?.effort;
  const effortLabel = shownEffort ? t(`models.effort.${shownEffort}`) : t('models.effort');
  const modeLabel = mode ? t(`approval.mode.${mode}`) : t('home.modeDefault');
  const modelLabel = resolved?.name ?? t('workbench.modelAuto');
  const effortItems = (resolved?.efforts ?? []).map((level) => ({
    id: `effort-${level}`,
    label: t(`models.effort.${level}`),
    selected: level === (effort ?? catalog?.effort),
    run: () => {
      setEffort(level);
    },
  }));
  const modelItems: MenuItem[] = [
    {
      id: 'auto-model',
      label: t('models.default'),
      selected: !model,
      run: () => {
        setModelKey('');
        setEffort(undefined);
      },
    },
    ...modelChoiceItems(
      catalog,
      (m) => keyOf(m) === modelKey,
      (m) => {
        setModelKey(keyOf(m));
        setEffort(undefined);
      },
    ),
    ...(effortItems.length > 1
      ? [{ id: 'effort', label: t('models.effort'), submenu: effortItems }]
      : []),
    {
      id: 'manage-models',
      label: t('models.manage'),
      run: () => {
        void window.piarc.openSettings('providers');
      },
    },
  ];
  return (
    <section className="home workbench-home" data-testid="home" data-starting={echo !== undefined}>
      <div className="environment-stage">
        {echo === undefined ? (
          <div className="home-hero" data-testid="home-hero">
            <Mascot />
            <div className="home-greeting" data-testid="home-greeting">
              {workspace === undefined ? (
                t('home.greeting.alone')
              ) : (
                <>
                  {t('home.greeting.before')}
                  <ChoiceButton
                    label={t('home.folder')}
                    valueLabel={label}
                    items={folderItems}
                    heading={t('jumpList.recentWorkspaces')}
                    filterLabel={t('home.searchProjects')}
                    above={false}
                    className="home-greeting-project"
                    testId="home-greeting-project"
                    value={workspace}
                    disabled={busy}
                  >
                    <span className="truncate">{label}</span>
                  </ChoiceButton>
                  {t('home.greeting.after')}
                </>
              )}
            </div>
          </div>
        ) : null}
        {echo === undefined ? null : (
          // Where the conversation will show it: the user's message at the top of the reading
          // column (quiet while it is on its way), the working line at the foot.
          <div className="home-pending">
            <div className="row row-user is-sending">
              <div className="row-user-bubble" data-testid="optimistic-message">
                <div className="row-user-text">{echo}</div>
              </div>
            </div>
            <div className="row row-working" role="status" data-testid="home-starting">
              <span className="working-mark">
                <ActivityMark activity="think" />
              </span>
              <span className="working-activity shimmer">{t('home.starting')}</span>
            </div>
          </div>
        )}
      </div>
      <div className="conversation-composer">
        <NoticeBar />
        <Composer
          {...(draftId === undefined ? {} : { sessionId: draftId })}
          savedDraft={
            workspace && draft === undefined ? store.editorDraft('workspace', workspace) : undefined
          }
          firstTurn
          dictation={
            workspace === undefined ? undefined : { composer: `workspace:${workspace}`, workspace }
          }
          running={false}
          disabled={busy || !workspace || (tree.enabled && tree.branches === undefined)}
          limits={ui.composer?.limits}
          supportsImages={resolved?.vision}
          mentions={mentions}
          commands={commands}
          fill={draft ? { text: draft, nonce: 0 } : undefined}
          handlers={{
            submit: (_intent, submission) => start(submission),
            stop: () => undefined,
            command: loadCommands,
            mentionOpened: () => undefined,
            mentionChosen: () => undefined,
            runCommand: (cmd) => {
              if (cmd.name === 'help') ui.openShortcuts();
              else if (cmd.name === 'model') modelButton.current?.click();
            },
          }}
          tray={
            <>
              <ChoiceButton
                label={t('workbench.environment')}
                valueLabel={localLabel}
                items={setupItems}
                disabled={busy}
                testId="home-environment"
              >
                {tree.enabled ? <GitBranchIcon /> : <ComputerIcon />}
                <span className="truncate">{localLabel}</span>
              </ChoiceButton>
              <ChoiceButton
                label={t('home.folder')}
                valueLabel={label}
                items={folderItems}
                heading={t('jumpList.recentWorkspaces')}
                testId="home-workspace"
                value={workspace}
                disabled={busy}
              >
                <FolderIcon />
                <span className="truncate">{label}</span>
              </ChoiceButton>
              {tree.enabled && <WorktreeFields choice={tree} disabled={busy} />}
            </>
          }
          leading={
            <ChoiceButton
              label={t('approval.modeMenu')}
              testId="home-mode"
              valueLabel={modeLabel}
              disabled={!workspace || busy}
              items={[
                {
                  id: 'workspace-mode',
                  label: t('home.modeDefault'),
                  selected: !mode,
                  run: () => {
                    setMode(undefined);
                  },
                },
                ...permissionChoices(t, preferences.permissions, mode, setMode),
              ]}
              heading={t('approval.modeMenu')}
            >
              {modeLabel}
            </ChoiceButton>
          }
          trailing={
            <>
              <ChoiceButton
                label={t('models.label')}
                className="composer-model"
                items={modelItems}
                heading={t('models.label')}
                filterLabel={t('models.search')}
                buttonRef={modelButton}
                valueLabel={modelLabel}
                disabled={!workspace || busy}
                onOpen={() => {
                  setCatalogRequested(workspace);
                }}
                testId="home-model"
              >
                {modelLabel}
              </ChoiceButton>
              {resolved && resolved.efforts.length > 1 && (
                <ChoiceButton
                  label={t('models.effort')}
                  className="composer-effort"
                  disabled={busy}
                  heading={t('models.effort')}
                  items={effortItems}
                  valueLabel={effortLabel}
                >
                  {effortLabel}
                </ChoiceButton>
              )}
            </>
          }
          above={
            (error ?? catalogFailure) && (
              <p className="composer-problems" role="alert" data-testid="home-error">
                {error ?? t('models.failed', { reason: catalogFailure ?? '' })}
              </p>
            )
          }
        />
      </div>
    </section>
  );
}

interface WorktreeChoice {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly base: string;
  readonly setBase: (base: string) => void;
  /** `undefined` before the answer, `false` outside a repository's top level. */
  readonly branches:
    | { readonly current?: string; readonly list: readonly string[]; readonly hookOnly: boolean }
    | false
    | undefined;
  /** What to send: nothing (no worktree), the options, or `invalid` for a bad name. */
  readonly options: WorktreeOptions | undefined | 'invalid';
}

/** The worktree part of the form; the branches are read when the box is ticked. */
function useWorktreeChoice(workspace: string | undefined): WorktreeChoice {
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState<WorktreeChoice['branches']>(undefined);
  useEffect(() => {
    setBranches(undefined);
    setBase('');
    if (!enabled || workspace === undefined) return;
    let active = true;
    window.piarc.worktreeBranches(workspace).then(
      (text) => {
        if (!active) return;
        const value: unknown = JSON.parse(text);
        const answer =
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
        if (answer.repository !== true && answer.hook !== true) {
          setBranches(false);
          return;
        }
        const list = Array.isArray(answer.branches)
          ? answer.branches.filter((b: unknown): b is string => typeof b === 'string')
          : [];
        setBranches({
          ...(typeof answer.current === 'string' ? { current: answer.current } : {}),
          list,
          hookOnly: answer.repository !== true && answer.hook === true,
        });
      },
      () => {
        if (active) setBranches(false);
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, workspace]);
  const trimmed = name.trim();
  const options: WorktreeChoice['options'] =
    !enabled || branches === false
      ? undefined
      : trimmed.length > 0 && !isWorktreeName(trimmed)
        ? 'invalid'
        : {
            ...(trimmed.length > 0 ? { name: trimmed } : {}),
            ...(base.length > 0 ? { base } : {}),
          };
  return { enabled, setEnabled, name, setName, base, setBase, branches, options };
}

function WorktreeFields({ choice, disabled }: { choice: WorktreeChoice; disabled: boolean }) {
  const t = useT();
  const nameId = useId();
  const baseId = useId();
  const { branches } = choice;
  return (
    <div className="worktree-fields" data-testid="home-worktree-fields">
      {choice.enabled && branches === false && (
        <p className="muted small" role="status" data-testid="home-worktree-unavailable">
          {t('home.worktreeNoRepo')}
        </p>
      )}
      {choice.enabled && branches !== false && (
        <div className="field-row">
          <label htmlFor={nameId} className="field-label">
            {t('home.worktreeName')}
          </label>
          <input
            id={nameId}
            className="input"
            value={choice.name}
            disabled={disabled}
            placeholder={t('home.worktreeNameHint')}
            aria-invalid={choice.options === 'invalid'}
            data-testid="home-worktree-name"
            onChange={(event) => {
              choice.setName(event.currentTarget.value);
            }}
          />
          {!branches?.hookOnly && (
            <>
              <label htmlFor={baseId} className="field-label">
                {t('home.worktreeBase')}
              </label>
              <select
                id={baseId}
                className="input"
                value={choice.base}
                disabled={disabled || branches === undefined}
                data-testid="home-worktree-base"
                onChange={(event) => {
                  choice.setBase(event.currentTarget.value);
                }}
              >
                <option value="">
                  {branches?.current === undefined
                    ? t('home.worktreeBaseDetached')
                    : t('home.worktreeBaseHead', { branch: branches.current })}
                </option>
                {branches?.list
                  .filter((branch) => branch !== branches.current)
                  .map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
              </select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
