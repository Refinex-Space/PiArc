// The application's command palette (Mod+K, architecture section 8.5, T37): the registered
// commands, switching to a session and the current session's slash commands, filtered with the
// same fuzzy matcher as the `/` palette. Keys go through the input method guard.
import { useEffect, useId, useMemo, useState } from 'react';

import { Keycaps } from '../app/Keycaps.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon, SearchIcon } from './icons.js';
import { revealListOption } from '../app/list-navigation.js';
import { fuzzyFilter } from '../../shared/fuzzy.js';
import type { AppCommand } from '../../shared/ipc.js';
import { COMMANDS, displayKey, effectiveBindings } from '../../shared/keybindings.js';
import { useApp } from '../app/app-context.js';
import { builtin } from '../composer/builtins.js';
import { parseCommandsList } from '../composer/commands-list.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSessions, useWorkspaces } from '../store/hooks.js';
import { Dialog } from './Dialog.js';
import { sessionTitle } from './SessionRow.js';

/** One row of the palette. */
interface Entry {
  readonly key: string;
  readonly group: 'actions' | 'sessions' | 'commands';
  readonly label: string;
  readonly detail: string;
  readonly binding?: string;
  readonly run: () => void;
}

export function CommandPalette({
  current,
  run,
  open,
  command,
  onClose,
}: {
  /** The session shown, whose slash commands are listed. */
  readonly current:
    | {
        readonly id: string;
        readonly workspace?: string | undefined;
        readonly cwd?: string | undefined;
      }
    | undefined;
  /** Runs a registered command. */
  readonly run: (command: AppCommand) => void;
  /** Shows a session. */
  readonly open: (sessionId: string) => void;
  /** Sends a slash command to the current session. */
  readonly command: (name: string) => void;
  readonly onClose: () => void;
}) {
  const { t, preferences, keyPlatform } = useApp();
  const workspaces = useWorkspaces();
  const sessions = useSessions();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [slash, setSlash] = useState<readonly { name: string; description: string }[]>([]);
  useEffect(() => {
    if (current?.workspace === undefined) return;
    let live = true;
    window.piarc
      .listCommands(current.workspace, current.cwd ?? null)
      .then((json) => {
        if (!live) return;
        setSlash(
          parseCommandsList(json).commands.map((c) => {
            const label = builtin(c.name)?.label;
            return { name: c.name, description: label === undefined ? c.description : t(label) };
          }),
        );
      })
      .catch((failure: unknown) => {
        console.error('[palette] cannot list the commands', failure);
      });
    return () => {
      live = false;
    };
  }, [current?.workspace, current?.cwd, t]);

  const entries = useMemo<Entry[]>(() => {
    const bindings = effectiveBindings(preferences.keybindings);
    const close = (then: () => void) => () => {
      onClose();
      then();
    };
    const actions: Entry[] = COMMANDS.filter((c) => c.id !== 'app.commandPalette').map((c) => ({
      key: `action:${c.id}`,
      group: 'actions',
      label: t(c.label),
      detail: displayKey(bindings[c.id], keyPlatform),
      binding: bindings[c.id],
      run: close(() => {
        run(c.id);
      }),
    }));
    const names = new Map(workspaces.map((w) => [w.path, w.displayName]));
    const sessionEntries: Entry[] = sessions
      .filter((s) => !s.archived && s.id !== current?.id)
      .map((s) => ({
        key: `session:${s.id}`,
        group: 'sessions',
        label: sessionTitle(s.title, t('session.untitled')),
        detail: names.get(s.workspace ?? '') ?? s.workspace ?? '',
        run: close(() => {
          open(s.id);
        }),
      }));
    const commandEntries: Entry[] =
      current === undefined
        ? []
        : slash.map((c) => ({
            key: `command:${c.name}`,
            group: 'commands',
            label: `/${c.name}`,
            detail: c.description,
            run: close(() => {
              command(c.name);
            }),
          }));
    return [...actions, ...sessionEntries, ...commandEntries];
  }, [
    preferences.keybindings,
    keyPlatform,
    t,
    run,
    open,
    command,
    onClose,
    workspaces,
    sessions,
    current,
    slash,
  ]);

  const matches = useMemo(() => {
    const found = fuzzyFilter(entries, query, (e) => [e.label, e.detail]);
    const order = { actions: 0, sessions: 1, commands: 2 } as const;
    return found
      .map((entry, rank) => ({ entry, rank }))
      .sort((a, b) => order[a.entry.group] - order[b.entry.group] || a.rank - b.rank)
      .map((r) => r.entry);
  }, [entries, query]);
  const active = matches.length === 0 ? -1 : Math.min(index, matches.length - 1);
  const groupTitle = {
    actions: t('palette.group.actions'),
    sessions: t('palette.group.sessions'),
    commands: t('palette.group.commands'),
  };

  return (
    <Dialog
      labelledBy={titleId}
      onCancel={onClose}
      dismissOnBackdrop
      className="command-palette"
      testId="command-palette"
    >
      <h2 id={titleId} className="visually-hidden">
        {t('palette.title')}
      </h2>
      <div className="palette-search">
        <SearchIcon />
        <input
          className="input palette-input"
          data-autofocus
          data-testid="command-palette-input"
          role="combobox"
          aria-label={t('palette.placeholder')}
          aria-expanded="true"
          aria-controls={`${titleId}-list`}
          aria-activedescendant={active === -1 ? undefined : `${titleId}-${String(active)}`}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const count = matches.length;
              if (count > 0) {
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setIndex((active + step + count) % count);
              }
            } else if (event.key === 'Enter') {
              event.preventDefault();
              matches[active]?.run();
            }
          }}
        />
        <IconButton label={t('shortcuts.close')} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <ul
        id={`${titleId}-list`}
        className="interactive-list palette-list"
        role="listbox"
        data-testid="command-palette-list"
      >
        {matches.map((entry, at) => (
          <li key={entry.key} role="presentation">
            {matches[at - 1]?.group === entry.group ? null : (
              <div className="palette-group" role="presentation">
                {groupTitle[entry.group]}
              </div>
            )}
            <div
              id={`${titleId}-${String(at)}`}
              role="option"
              ref={at === active ? revealListOption : undefined}
              aria-selected={at === active}
              className={at === active ? 'palette-option is-active' : 'palette-option'}
              data-entry={entry.key}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={entry.run}
            >
              <span className="palette-label" title={entry.label}>
                {entry.label}
              </span>
              {entry.binding ? (
                <Keycaps binding={entry.binding} platform={keyPlatform} />
              ) : (
                entry.detail && (
                  <span className="palette-detail muted" title={entry.detail}>
                    {entry.detail}
                  </span>
                )
              )}
            </div>
          </li>
        ))}
      </ul>
      {matches.length === 0 && (
        <p className="palette-empty muted" role="status">
          {t('palette.none')}
        </p>
      )}
    </Dialog>
  );
}
