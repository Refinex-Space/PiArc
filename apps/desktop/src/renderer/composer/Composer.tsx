// The composer (architecture sections 8.2 and 8.5): ProseMirror multi-line input with `@` mention
// chips found by Core's fuzzy file search, the `/` command palette of Core's commands, image and
// PDF attachments by drop or paste, the idle/running key semantics of intents.ts, and the input
// method guard in front of every key and trigger. Pasting text inserts plain text only.
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keydownHandler, keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApp } from '../app/app-context.js';
import { formatSize } from '../transcript/rows/common.js';
import {
  checkFiles,
  type AttachmentLimits,
  type AttachmentProblem,
  type PendingAttachment,
} from './attachments.js';
import {
  CLOSED_COMMANDS,
  closeCommands,
  commandKey,
  commandPlugin,
  filterCommands,
  moveCommands,
  openCommands,
  type CommandState,
  type PaletteCommand,
} from './command-plugin.js';
import { isImeComposing } from './ime-guard.js';
import { COMPOSER_KEYS, intentFor, type ComposerKey } from './intents.js';
import {
  CLOSED_MENTION,
  chooseMention,
  closeMention,
  mentionKey,
  mentionPlugin,
  moveMention,
  openMention,
  type MentionState,
} from './mention-plugin.js';
import { composerSchema, type MentionData } from './schema.js';
import { isBlank, serializeDoc, type ComposerPayload } from './serialize.js';

/** What the composer hands over on Enter / Mod+Enter. */
export interface ComposerSubmission extends ComposerPayload {
  readonly attachments: readonly PendingAttachment[];
}

export interface ComposerHandlers {
  /** Enter, Mod+Enter: send when idle; steer or queue while running. */
  submit(intent: 'send' | 'steer' | 'queue', submission: ComposerSubmission): void;
  /** Esc while running. */
  stop(): void;
  /** `/` typed into an empty composer opened the palette. */
  command(): void;
  /** A command was chosen in the palette. */
  runCommand?(command: PaletteCommand): void;
  /** `@` opened the mention picker. */
  mentionOpened(): void;
  /** A mention was inserted. */
  mentionChosen(mention: MentionData): void;
}

/** Where `@` candidates come from (Core's file search; a fixed list on the prototype page). */
export interface MentionSource {
  /** The candidates for `query`; a newer call supersedes an older one. */
  search(query: string): Promise<readonly MentionData[]>;
  /** The picker closed: stop searching. */
  cancel(): void;
}

function emptyState(): EditorState {
  return EditorState.create({
    schema: composerSchema,
    plugins: [
      mentionPlugin(),
      commandPlugin(),
      history(),
      keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo }),
      keymap(baseKeymap),
    ],
  });
}

function clearCommand(): Command {
  return (state, dispatch) => {
    dispatch?.(
      state.tr.replaceWith(0, state.doc.content.size, composerSchema.nodes.paragraph.create()),
    );
    return true;
  };
}

/** Plain-text paste: one paragraph per line, never the clipboard's HTML. */
function pastePlainText(view: EditorView, text: string): void {
  const paragraphs = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) =>
      composerSchema.node('paragraph', null, line === '' ? [] : [composerSchema.text(line)]),
    );
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)));
}

/** Files of a paste or drop. */
function filesOf(transfer: DataTransfer | null): File[] {
  return transfer === null ? [] : [...transfer.files];
}

export function Composer({
  running,
  disabled = false,
  handlers,
  mentions,
  commands,
  limits,
  supportsImages = true,
  above,
  error,
  fill,
}: {
  running: boolean;
  disabled?: boolean;
  handlers: ComposerHandlers;
  mentions: MentionSource;
  commands: readonly PaletteCommand[];
  /** What can be attached; without limits nothing can. */
  limits: AttachmentLimits | undefined;
  supportsImages?: boolean | undefined;
  /** Shown above the input (the queue). */
  above?: ReactNode;
  /** Why the last message was not sent. */
  error?: string | undefined;
  /**
   * Text to put in the input in place of what is there (a rewound message, T28); a new `nonce`
   * puts it again.
   */
  fill?: { readonly text: string; readonly nonce: number } | undefined;
}) {
  const { t, platform } = useApp();
  const mount = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [mention, setMention] = useState<MentionState>(CLOSED_MENTION);
  const [palette, setPalette] = useState<CommandState>(CLOSED_COMMANDS);
  const [results, setResults] = useState<{ query: string; items: readonly MentionData[] }>({
    query: '',
    items: [],
  });
  const [pending, setPending] = useState<readonly PendingAttachment[]>([]);
  const [problems, setProblems] = useState<readonly AttachmentProblem[]>([]);
  const [empty, setEmpty] = useState(true);
  // The editor's callbacks are created once; they read the latest values through this ref.
  const latest = useRef({
    running,
    disabled,
    handlers,
    mentions,
    commands,
    limits,
    supportsImages,
    results,
    pending,
  });
  latest.current = {
    running,
    disabled,
    handlers,
    mentions,
    commands,
    limits,
    supportsImages,
    results,
    pending,
  };

  const addFiles = (files: readonly File[]): void => {
    const { limits: current, pending: attached } = latest.current;
    if (files.length === 0) {
      return;
    }
    const { accepted, problems: refused } = checkFiles(
      files,
      attached.length,
      current ?? { maxCount: 0, kinds: [] },
      () => crypto.randomUUID(),
      latest.current.supportsImages,
    );
    setPending((list) => [...list, ...accepted]);
    setProblems(refused);
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const submitInput = (
    intent: 'send' | 'steer' | 'queue',
    state: EditorState,
    view?: EditorView,
  ) => {
    const {
      pending: attachments,
      handlers: current,
      disabled: locked,
      supportsImages: vision,
    } = latest.current;
    if (!vision) {
      const refused = attachments
        .filter((a) => a.kind === 'image')
        .map((a) => ({ reason: 'vision' as const, name: a.name }));
      if (refused.length) {
        setProblems(refused);
        return;
      }
    }
    const payload = serializeDoc(state.doc);
    if (locked || (isBlank(payload) && attachments.length === 0)) return;
    current.submit(intent, { ...payload, attachments });
    if (view) clearCommand()(state, view.dispatch.bind(view), view);
    setPending([]);
    setProblems([]);
  };
  const send = useRef(submitInput);
  send.current = submitInput;
  useEffect(() => {
    const element = mount.current;
    if (element === null) {
      return;
    }
    const command =
      (key: ComposerKey): Command =>
      (state, dispatch, view) => {
        const intent = intentFor(key, latest.current.running);
        switch (intent) {
          case 'newline':
            return splitBlock(state, dispatch);
          case 'stop':
            latest.current.handlers.stop();
            return true;
          case 'send':
          case 'steer':
          case 'queue':
            send.current(intent, state, view);
            return true;
          case null:
            return false;
        }
      };
    const keys = keydownHandler(
      Object.fromEntries(COMPOSER_KEYS.map((key) => [key, command(key)])),
    );
    const runPaletteCommand = (editor: EditorView, choice: PaletteCommand | undefined): void => {
      editor.dispatch(closeCommands(editor.state));
      if (choice !== undefined) {
        clearCommand()(editor.state, editor.dispatch.bind(editor), editor);
        latest.current.handlers.runCommand?.(choice);
      }
    };

    const view = new EditorView(element, {
      state: emptyState(),
      attributes: {
        class: 'composer-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('composer.label'),
        'data-testid': 'composer-input',
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        setMention(mentionKey.getState(next) ?? CLOSED_MENTION);
        setPalette(commandKey.getState(next) ?? CLOSED_COMMANDS);
        setEmpty(
          next.doc.childCount === 1 &&
            next.doc.textContent === '' &&
            next.doc.firstChild?.childCount === 0,
        );
      },
      handleDOMEvents: {
        // Input method guard, ahead of everything ProseMirror does with a key: returning true
        // skips its keydown handling (key bindings, base keymap, plugins) without
        // preventDefault, so the key goes to the input method untouched. This also covers
        // keyCode 229 keys that arrive before compositionstart, when ProseMirror itself does
        // not consider the editor composing yet.
        keydown: (editor, event) => isImeComposing(event, editor.composing),
        drop: (_editor, event) => {
          const files = filesOf(event.dataTransfer);
          if (files.length === 0) {
            return false;
          }
          event.preventDefault();
          addFilesRef.current(files);
          return true;
        },
      },
      handleKeyDown(editor, event) {
        if (isImeComposing(event, editor.composing)) {
          return false;
        }
        const picker = mentionKey.getState(editor.state) ?? CLOSED_MENTION;
        if (picker.active) {
          const matches = latest.current.results.items;
          switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
              editor.dispatch(moveMention(editor.state, event.key === 'ArrowDown' ? 1 : -1));
              return true;
            case 'Enter':
            case 'Tab': {
              const count = matches.length;
              const choice =
                count === 0 ? undefined : matches[((picker.index % count) + count) % count];
              if (choice === undefined) {
                editor.dispatch(closeMention(editor.state));
              } else {
                editor.dispatch(chooseMention(editor.state, choice));
                latest.current.handlers.mentionChosen(choice);
              }
              latest.current.mentions.cancel();
              return true;
            }
            case 'Escape':
              editor.dispatch(closeMention(editor.state));
              latest.current.mentions.cancel();
              return true;
            default:
              break;
          }
        }
        const open = commandKey.getState(editor.state) ?? CLOSED_COMMANDS;
        if (open.active) {
          const matches = filterCommands(latest.current.commands, open.query);
          const count = matches.length;
          switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
              editor.dispatch(moveCommands(editor.state, event.key === 'ArrowDown' ? 1 : -1));
              return true;
            case 'Enter':
            case 'Tab':
              runPaletteCommand(
                editor,
                count === 0 ? undefined : matches[((open.index % count) + count) % count],
              );
              return true;
            case 'Escape':
              editor.dispatch(closeCommands(editor.state));
              return true;
            default:
              break;
          }
        }
        return keys(editor, event);
      },
      handleTextInput(editor, from, to, text) {
        // Text committed by an input method arrives here too; triggers only fire outside one.
        if (editor.composing) {
          return false;
        }
        if (text === '@') {
          editor.dispatch(openMention(editor.state, from, to));
          latest.current.handlers.mentionOpened();
          return true;
        }
        if (
          text === '/' &&
          editor.state.doc.textContent === '' &&
          editor.state.doc.childCount === 1
        ) {
          editor.dispatch(openCommands(editor.state, from, to));
          latest.current.handlers.command();
          return true;
        }
        return false;
      },
      handlePaste: (editor, event) => {
        const files = filesOf(event.clipboardData);
        if (files.length > 0) {
          addFilesRef.current(files);
          return true;
        }
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (text !== '') {
          pastePlainText(editor, text);
        }
        return true;
      },
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor is created once; translations of its label follow on the next mount.
  }, []);

  // A message given back for the input: plain text, one paragraph per line, then focus.
  const fillText = fill?.text;
  const fillNonce = fill?.nonce;
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || fillText === undefined || fillNonce === undefined) return;
    const paragraphs = fillText
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) =>
        composerSchema.node('paragraph', null, line === '' ? [] : [composerSchema.text(line)]),
      );
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraphs));
    view.focus();
  }, [fillText, fillNonce]);

  // Core's file search for the mention picker's query.
  useEffect(() => {
    if (!mention.active) {
      return;
    }
    let current = true;
    const query = mention.query;
    mentions.search(query).then(
      (items) => {
        if (current) {
          setResults({ query, items });
        }
      },
      (failure: unknown) => {
        if (current && !(failure instanceof Error && failure.message.includes('cancelled'))) {
          console.error('[composer] the file search failed', failure);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [mention.active, mention.query, mentions]);

  const matches = mention.active && results.query === mention.query ? results.items : [];
  const searching = mention.active && results.query !== mention.query;
  const highlighted =
    matches.length === 0
      ? -1
      : ((mention.index % matches.length) + matches.length) % matches.length;
  const paletteMatches = palette.active ? filterCommands(commands, palette.query) : [];
  const paletteIndex =
    paletteMatches.length === 0
      ? -1
      : ((palette.index % paletteMatches.length) + paletteMatches.length) % paletteMatches.length;
  const queueKey = platform === 'darwin' ? '⌘↩' : 'Ctrl+Enter';
  const problemText = (problem: AttachmentProblem): string => {
    switch (problem.reason) {
      case 'vision':
        return t('composer.attachment.vision', { name: problem.name });
      case 'type':
        return t('composer.attachment.type', { name: problem.name });
      case 'size':
        return t('composer.attachment.size', {
          name: problem.name,
          limit: formatSize(problem.maxBytes),
        });
      case 'count':
        return t('composer.attachment.count', { count: problem.maxCount });
    }
  };
  return (
    <div
      className="composer"
      data-testid="composer"
      data-running={running}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        // A drop on the editor itself was taken by ProseMirror already.
        if (event.defaultPrevented) {
          return;
        }
        const files = filesOf(event.dataTransfer);
        if (files.length > 0) {
          event.preventDefault();
          addFiles(files);
        }
      }}
    >
      {above}
      {mention.active ? (
        <ul
          className="composer-popup mention-popup"
          role="listbox"
          data-testid="mention-popup"
          aria-label={t('composer.mentions.label')}
        >
          {matches.length === 0 ? (
            <li className="mention-empty">
              {searching ? t('composer.mentions.searching') : t('composer.mentions.none')}
            </li>
          ) : (
            matches.map((candidate, index) => (
              <li
                key={candidate.id}
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? 'mention-option is-active' : 'mention-option'}
                onMouseDown={(event) => {
                  event.preventDefault();
                  const view = viewRef.current;
                  if (view !== null) {
                    view.dispatch(chooseMention(view.state, candidate));
                    handlers.mentionChosen(candidate);
                    mentions.cancel();
                  }
                }}
              >
                <span className="mention-label">@{candidate.label}</span>
                <span className="mention-path">{candidate.path}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {palette.active ? (
        <ul
          className="composer-popup command-popup"
          role="listbox"
          data-testid="command-popup"
          aria-label={t('composer.commands.label')}
        >
          {paletteMatches.length === 0 ? (
            <li className="mention-empty">{t('composer.commands.none')}</li>
          ) : (
            paletteMatches.map((choice, index) => (
              <li
                key={choice.name}
                role="option"
                aria-selected={index === paletteIndex}
                data-command={choice.name}
                className={index === paletteIndex ? 'mention-option is-active' : 'mention-option'}
                onMouseDown={(event) => {
                  event.preventDefault();
                  const view = viewRef.current;
                  if (view !== null) {
                    view.dispatch(closeCommands(view.state));
                    clearCommand()(view.state, view.dispatch.bind(view), view);
                    handlers.runCommand?.(choice);
                  }
                }}
              >
                <span className="mention-label">/{choice.name}</span>
                <span className="mention-path">
                  {choice.source === 'builtin' && isBuiltinName(choice.name)
                    ? t(`composer.command.${choice.name}`)
                    : choice.description}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {pending.length === 0 ? null : (
        <div className="composer-attachments" data-testid="composer-attachments">
          {pending.map((attachment) => (
            <span
              key={attachment.id}
              className={`attachment-chip is-${attachment.kind}`}
              data-testid="pending-attachment"
              data-kind={attachment.kind}
            >
              <span className="attachment-chip-icon" aria-hidden="true">
                {attachment.kind === 'pdf' ? 'PDF' : 'IMG'}
              </span>
              <span className="attachment-chip-name">
                {attachment.name} · {formatSize(attachment.size)}
              </span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={t('composer.attachment.remove', { name: attachment.name })}
                onClick={() => {
                  setPending((list) => list.filter((entry) => entry.id !== attachment.id));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {problems.length === 0 && error === undefined ? null : (
        <div className="composer-problems" role="alert" data-testid="composer-problems">
          {problems.map((problem, index) => (
            <div key={index}>{problemText(problem)}</div>
          ))}
          {error === undefined ? null : <div>{error}</div>}
        </div>
      )}
      <div className={`composer-box${disabled ? ' is-disabled' : ''}`}>
        <div
          ref={mount}
          className="composer-mount"
          data-empty={empty}
          data-placeholder={t('composer.placeholder')}
        />
        <div className="composer-actions">
          <label className="icon-button composer-attach" title={t('composer.attach')}>
            <input
              type="file"
              className="visually-hidden"
              data-testid="composer-file-input"
              accept={(limits?.kinds ?? []).flatMap((kind) => kind.mimeTypes).join(',')}
              multiple
              onChange={(event) => {
                addFiles([...(event.currentTarget.files ?? [])]);
                event.currentTarget.value = '';
              }}
            />
            <span aria-hidden="true">＋</span>
            <span className="visually-hidden">{t('composer.attach')}</span>
          </label>
          {running ? (
            <button
              type="button"
              className="button composer-stop"
              data-testid="composer-stop"
              onClick={() => {
                handlers.stop();
              }}
            >
              {t('composer.stop')}
            </button>
          ) : null}
          <button
            type="button"
            className="button button-primary composer-send"
            data-testid="composer-send"
            disabled={disabled}
            onClick={() => {
              const view = viewRef.current;
              if (view === null) {
                return;
              }
              send.current(running ? 'steer' : 'send', view.state, view);
              view.focus();
            }}
          >
            {t('composer.send')}
          </button>
        </div>
      </div>
      <div className="composer-hint" aria-live="polite">
        {running ? t('composer.hint.running', { queue: queueKey }) : t('composer.hint.idle')}
      </div>
    </div>
  );
}

const BUILTIN_NAMES = new Set(['clear', 'compact', 'rewind', 'help']);

function isBuiltinName(name: string): name is 'clear' | 'compact' | 'rewind' | 'help' {
  return BUILTIN_NAMES.has(name);
}
