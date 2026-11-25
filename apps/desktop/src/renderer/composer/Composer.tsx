// The composer (architecture sections 8.2 and 8.5): ProseMirror multi-line input with `@` mention
// chips found by Core's fuzzy file search, the `/` command palette of Core's commands, image and
// PDF attachments by drop or paste, the idle/running key semantics of intents.ts, and the input
// method guard in front of every key and trigger. Pasting text inserts plain text only.
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keydownHandler, keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment as ReactFragment, useEffect, useRef, useState, type ReactNode } from 'react';

import { fileMentionPath, type MentionScope } from '../files/file-path.js';
import { onFileAttachment, droppedFiles, FILE_DRAG_TYPE } from '../files/navigation.js';
import type { EditorDraft } from './session-draft.js';
import { IconButton } from '../app/IconButton.js';
import {
  CloseGlyph,
  CommandIcon,
  FileCodeCornerIcon,
  FileGlyph,
  GearIcon,
  ImageGlyph,
  LayoutFreeformIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  UnplugIcon,
} from '../shell/icons.js';
import { MenuPopup, useMenu, type MenuItem } from '../shell/Menu.js';
import { revealListOption } from '../app/list-navigation.js';
import type { MessageId } from '../../shared/i18n/index.js';
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
import { builtin } from './builtins.js';
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
import { composerSchema, type MentionData, type SnippetData } from './schema.js';
import { isBlank, serializeDoc, type ComposerPayload } from './serialize.js';

/** What the composer hands over on Enter / Mod+Enter. */
export interface ComposerSubmission extends ComposerPayload {
  readonly attachments: readonly PendingAttachment[];
}

export interface ComposerHandlers {
  /** Enter, Mod+Enter: send when idle; steer or queue while running. */
  submit(
    intent: 'send' | 'steer' | 'queue',
    submission: ComposerSubmission,
  ): boolean | Promise<boolean>;
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

/** Presses this soon after send and stop swapped places are ignored (ms). */
const SWAP_GUARD_MS = 500;

function emptyState(doc?: EditorState['doc']): EditorState {
  return EditorState.create({
    schema: composerSchema,
    ...(doc ? { doc } : {}),
    plugins: [
      mentionPlugin(),
      commandPlugin(),
      history(),
      keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo }),
      keymap(baseKeymap),
    ],
  });
}

/** Puts `/name ` in the input with the cursor after it, the palette closed. */
function fillCommand(view: EditorView, name: string): void {
  const text = `/${name} `;
  const paragraph = composerSchema.nodes.paragraph.create(null, composerSchema.text(text));
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph);
  view.dispatch(
    tr
      .setSelection(TextSelection.create(tr.doc, text.length + 1))
      .setMeta(commandKey, { type: 'close' }),
  );
  view.focus();
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

function insertFileMentions(
  view: EditorView,
  paths: readonly string[],
  scope: MentionScope | undefined,
) {
  if (!paths.length) return;
  const nodes = paths.flatMap((path) => [
    composerSchema.node('mention', {
      id: path,
      label: path.split('/').at(-1) ?? path,
      path: fileMentionPath(path, scope),
    }),
    composerSchema.text(' '),
  ]);
  view.dispatch(
    view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView(),
  );
  view.focus();
}

/** Files of a paste or drop. */
function filesOf(transfer: DataTransfer | null): File[] {
  return transfer === null ? [] : [...transfer.files];
}

export function Composer({
  running,
  savedDraft,
  sessionId,
  fileScope,
  firstTurn = false,
  disabled = false,
  handlers,
  mentions,
  commands,
  limits,
  supportsImages = true,
  above,
  error,
  fill,
  insert,
}: {
  running: boolean;
  savedDraft?: EditorDraft | undefined;
  sessionId?: string;
  fileScope?: MentionScope;
  firstTurn?: boolean;
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
  /** Chips to insert at the cursor (T34: terminal selections); a new `nonce` inserts again. */
  insert?: { readonly snippets: readonly SnippetData[]; readonly nonce: number } | undefined;
}) {
  const { t, platform } = useApp();
  const add = useMenu();
  const fileInput = useRef<HTMLInputElement>(null);
  const saved = useRef(savedDraft);
  const mount = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [mention, setMention] = useState<MentionState>(CLOSED_MENTION);
  const [palette, setPalette] = useState<CommandState>(CLOSED_COMMANDS);
  const [results, setResults] = useState<{ query: string; items: readonly MentionData[] }>({
    query: '',
    items: [],
  });
  const [pending, setPending] = useState<readonly PendingAttachment[]>(saved.current?.files ?? []);
  const [problems, setProblems] = useState<readonly AttachmentProblem[]>([]);
  const [empty, setEmpty] = useState(
    !saved.current?.doc?.content.size || saved.current.doc.content.size === 2,
  );
  const currentFiles = useRef(pending);
  currentFiles.current = pending;
  // The editor's callbacks are created once; they read the latest values through this ref.
  const latest = useRef({
    running,
    disabled,
    handlers,
    mentions,
    commands,
    limits,
    supportsImages,
    sessionId,
    fileScope,
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
    sessionId,
    fileScope,
    results,
    pending,
  };

  const addFiles = (files: readonly File[]): void => {
    const { limits: current, pending: attached } = latest.current;
    if (latest.current.disabled || files.length === 0) {
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
    const clear = () => {
      if (savedDraft) {
        delete savedDraft.doc;
        delete savedDraft.files;
      }
      if (!view || view.isDestroyed || view.state.doc !== state.doc) return;
      clearCommand()(view.state, view.dispatch.bind(view), view);
      currentFiles.current = [];
      setPending([]);
      setProblems([]);
    };
    const result = current.submit(intent, { ...payload, attachments });
    if (typeof result === 'boolean') {
      if (result) clear();
    } else
      void result.then((sent) => {
        if (sent) clear();
      });
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
      if (choice === undefined) return;
      if (choice.kind !== 'builtIn') {
        // A command file or skill goes to Core as `/name arguments`: the user types the
        // arguments after it (T37).
        fillCommand(editor, choice.name);
        return;
      }
      clearCommand()(editor.state, editor.dispatch.bind(editor), editor);
      latest.current.handlers.runCommand?.(choice);
    };

    const view = new EditorView(element, {
      state: emptyState(saved.current?.doc),
      editable: () => !latest.current.disabled,
      attributes: {
        class: 'composer-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t(firstTurn ? 'home.placeholder' : 'composer.label'),
        'data-testid': firstTurn ? 'home-input' : 'composer-input',
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
        drop: (editor, event) => {
          const paths = droppedFiles(event.dataTransfer, latest.current.sessionId);
          if (paths) {
            event.preventDefault();
            insertFileMentions(editor, paths, latest.current.fileScope);
            return true;
          }
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
          const matches =
            latest.current.results.query === picker.query ? latest.current.results.items : [];
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
    if (firstTurn && !latest.current.disabled) view.focus();
    return () => {
      if (savedDraft) {
        if (isBlank(serializeDoc(view.state.doc))) delete savedDraft.doc;
        else savedDraft.doc = view.state.doc;
        if (currentFiles.current.length) savedDraft.files = currentFiles.current;
        else delete savedDraft.files;
      }
      viewRef.current = null;
      view.destroy();
    };
    // The editor is created once; translations of its label follow on the next mount.
  }, []);

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !disabled });
  }, [disabled]);

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

  // Snippets attached elsewhere in the window (the terminal panel) go in at the cursor.
  useEffect(
    () =>
      sessionId
        ? onFileAttachment(sessionId, (paths) => {
            if (viewRef.current)
              insertFileMentions(viewRef.current, paths, latest.current.fileScope);
          })
        : undefined,
    [sessionId],
  );
  const insertNonce = insert?.nonce;
  const insertSnippets = insert?.snippets;
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || insertSnippets === undefined || insertNonce === undefined) return;
    const nodes = insertSnippets.flatMap((snippet) => [
      composerSchema.node('snippet', { ...snippet }),
      composerSchema.text(' '),
    ]);
    view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)));
    view.focus();
  }, [insertSnippets, insertNonce]);

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
  // Running with nothing typed, the button stops the turn; a draft turns it back into send (a
  // steer). A press within SWAP_GUARD_MS of the swap is ignored: a double click does not do both.
  const stopping = running && empty && pending.length === 0;
  const swappedAt = useRef(Number.NEGATIVE_INFINITY);
  const shownStop = useRef(stopping);
  useEffect(() => {
    if (shownStop.current !== stopping) swappedAt.current = performance.now();
    shownStop.current = stopping;
  }, [stopping]);
  const swapGuard = () => performance.now() - swappedAt.current >= SWAP_GUARD_MS;
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
  const menuItems: MenuItem[] = [
    {
      id: 'attach',
      label: t('composer.attach'),
      icon: <PaperclipIcon />,
      disabled: !limits?.kinds.length,
      run: () => fileInput.current?.click(),
    },
    {
      id: 'mention',
      label: t('composer.mentions.label'),
      icon: <FileCodeCornerIcon />,
      run: () => {
        const editor = viewRef.current;
        if (!editor) return;
        const { from, to } = editor.state.selection;
        editor.dispatch(openMention(editor.state, from, to));
        handlers.mentionOpened();
        editor.focus();
      },
    },
    {
      id: 'commands',
      label: t('composer.commands.label'),
      icon: <CommandIcon />,
      disabled: !empty,
      run: () => {
        const editor = viewRef.current;
        if (!editor) return;
        const { from, to } = editor.state.selection;
        editor.dispatch(openCommands(editor.state, from, to));
        handlers.command();
        editor.focus();
      },
    },
    ...(savedDraft !== undefined || firstTurn
      ? [
          {
            id: 'skills',
            label: t('skills.title'),
            icon: <LayoutFreeformIcon />,
            submenu: [
              ...commands
                .filter((c) => c.kind === 'skill')
                .map((c) => ({
                  id: c.name,
                  label: c.name,
                  tooltip: c.description,
                  disabled: !empty,
                  run: () => {
                    const view = viewRef.current;
                    if (view) fillCommand(view, c.name);
                  },
                })),
              {
                id: 'manage-skills',
                label: t('settings.skills'),
                icon: <GearIcon />,
                run: () => {
                  void window.piarc.openSettings('skills');
                },
              },
            ],
          },
          {
            id: 'manage-connectors',
            label: t('settings.mcp'),
            icon: <UnplugIcon />,
            run: () => {
              void window.piarc.openSettings('mcp');
            },
          },
        ]
      : []),
  ];

  return (
    <div
      className="composer"
      data-testid="composer"
      data-running={running}
      onDragOver={(event) => {
        if (
          event.dataTransfer.types.includes('Files') ||
          event.dataTransfer.types.includes(FILE_DRAG_TYPE)
        ) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        // A drop on the editor itself was taken by ProseMirror already.
        if (event.defaultPrevented) {
          return;
        }
        const paths = droppedFiles(event.dataTransfer, sessionId);
        if (paths && viewRef.current) {
          event.preventDefault();
          insertFileMentions(viewRef.current, paths, latest.current.fileScope);
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
          className="interactive-list composer-popup mention-popup"
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
                ref={index === highlighted ? revealListOption : undefined}
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
                <FileCodeCornerIcon />
                <span className="mention-label">{candidate.label}</span>
                <span className="mention-path">{candidate.path}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {palette.active ? (
        <ul
          className="interactive-list composer-popup command-popup"
          role="listbox"
          data-testid="command-popup"
          aria-label={t('composer.commands.label')}
        >
          {paletteMatches.length === 0 ? (
            <li className="mention-empty">{t('composer.commands.none')}</li>
          ) : (
            paletteMatches.map((choice, index) => {
              const previous = paletteMatches[index - 1];
              const label = builtin(choice.name)?.label;
              return (
                <ReactFragment key={`${choice.source}:${choice.name}`}>
                  {previous?.source === choice.source ? null : (
                    <li
                      className="command-group"
                      role="presentation"
                      data-testid="command-group"
                      data-source={choice.source}
                    >
                      {sourceLabel(t, choice.source)}
                    </li>
                  )}
                  <li
                    role="option"
                    ref={index === paletteIndex ? revealListOption : undefined}
                    aria-selected={index === paletteIndex}
                    data-command={choice.name}
                    data-kind={choice.kind}
                    className={
                      index === paletteIndex ? 'mention-option is-active' : 'mention-option'
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                      const view = viewRef.current;
                      if (view === null) return;
                      view.dispatch(closeCommands(view.state));
                      if (choice.kind !== 'builtIn') {
                        fillCommand(view, choice.name);
                        return;
                      }
                      clearCommand()(view.state, view.dispatch.bind(view), view);
                      handlers.runCommand?.(choice);
                    }}
                  >
                    <span className="mention-label">
                      /{choice.name}
                      {choice.argumentHint === undefined ? null : (
                        <span
                          className="command-hint"
                          data-testid="command-hint"
                          title={t('composer.commands.args', { hint: choice.argumentHint })}
                        >
                          {' '}
                          {choice.argumentHint}
                        </span>
                      )}
                      {choice.kind === 'skill' ? (
                        <span className="command-kind">{t('composer.commands.kind.skill')}</span>
                      ) : null}
                    </span>
                    <span className="mention-path">
                      {label === undefined ? choice.description : t(label)}
                    </span>
                  </li>
                </ReactFragment>
              );
            })
          )}
        </ul>
      ) : null}
      {problems.length === 0 && error === undefined ? null : (
        <div className="composer-problems" role="alert" data-testid="composer-problems">
          {problems.map((problem, index) => (
            <div key={index}>{problemText(problem)}</div>
          ))}
          {error === undefined ? null : <div>{error}</div>}
        </div>
      )}
      <div className={`composer-box${disabled ? ' is-disabled' : ''}`}>
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
                  {attachment.kind === 'pdf' ? <FileGlyph size={20} /> : <ImageGlyph size={20} />}
                </span>
                <span className="attachment-chip-text">
                  <span className="attachment-chip-name">{attachment.name}</span>
                  <span className="attachment-chip-size">{formatSize(attachment.size)}</span>
                </span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={t('composer.attachment.remove', { name: attachment.name })}
                  data-tooltip={t('composer.attachment.remove', { name: attachment.name })}
                  onClick={() => {
                    setPending((list) => list.filter((entry) => entry.id !== attachment.id));
                  }}
                >
                  <CloseGlyph size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <IconButton
          label={t('composer.add')}
          size="sm"
          className="composer-attach"
          data-testid="composer-add"
          aria-haspopup="menu"
          aria-expanded={add.open !== null}
          disabled={disabled}
          onClick={(event) => {
            handlers.command();
            add.openAbove(event.currentTarget);
          }}
        >
          <PlusIcon />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label={t('composer.attach')}
          data-testid="composer-file-input"
          accept={(limits?.kinds ?? []).flatMap((kind) => kind.mimeTypes).join(',')}
          multiple
          onChange={(event) => {
            addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = '';
          }}
        />
        {add.open !== null && (
          <MenuPopup
            at={add.open}
            onClose={add.close}
            label={t('composer.add')}
            items={menuItems}
          />
        )}
        <div
          ref={mount}
          className="composer-mount"
          data-empty={empty}
          data-placeholder={
            firstTurn
              ? t('home.placeholder')
              : running
                ? t('composer.placeholder.running', { queue: queueKey })
                : t('composer.placeholder')
          }
        />
        {stopping ? (
          <IconButton
            key="stop"
            label={t('composer.stop')}
            keys="Escape"
            size="sm"
            className="composer-stop composer-swap"
            data-testid="composer-stop"
            onClick={() => {
              if (swapGuard()) handlers.stop();
            }}
          >
            <StopIcon />
          </IconButton>
        ) : (
          <IconButton
            key="send"
            label={t(firstTurn ? 'home.send' : 'composer.send')}
            keys="Enter"
            size="sm"
            className="composer-send composer-swap"
            data-testid={firstTurn ? 'home-start' : 'composer-send'}
            disabled={disabled || (empty && pending.length === 0)}
            onClick={() => {
              const editor = viewRef.current;
              if (editor && swapGuard()) {
                send.current(running ? 'steer' : 'send', editor.state, editor);
                editor.focus();
              }
            }}
          >
            <SendIcon />
          </IconButton>
        )}
      </div>
      <div className="visually-hidden" aria-live="polite">
        {running ? t('composer.hint.running', { queue: queueKey }) : t('composer.hint.idle')}
      </div>
    </div>
  );
}

const SOURCE_LABELS: Readonly<Record<string, MessageId>> = {
  builtIn: 'composer.commands.source.builtIn',
  projectPiarc: 'composer.commands.source.projectPiarc',
  projectClaude: 'composer.commands.source.projectClaude',
  projectPi: 'composer.commands.source.projectPi',
  user: 'composer.commands.source.user',
  userClaude: 'composer.commands.source.userClaude',
  userPi: 'composer.commands.source.userPi',
  plugin: 'composer.commands.source.plugin',
  mcp: 'composer.commands.source.mcp',
};

/** The palette's group title of a command source. */
export function sourceLabel(t: (id: MessageId) => string, source: string): string {
  const id = Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : undefined;
  return id === undefined ? source : t(id);
}
