// The composer (architecture sections 8.2 and 8.5): ProseMirror multi-line input with `@` mention
// chips, the idle/running key semantics of intents.ts, and the input method guard in front of
// every key and trigger. Pasting inserts plain text only.
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keydownHandler, keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef, useState } from 'react';

import { isImeComposing } from './ime-guard.js';
import { COMPOSER_KEYS, intentFor, type ComposerKey } from './intents.js';
import {
  CLOSED_MENTION,
  chooseMention,
  closeMention,
  matchCandidates,
  mentionKey,
  mentionPlugin,
  moveMention,
  openMention,
  type MentionState,
} from './mention-plugin.js';
import { composerSchema, type MentionData } from './schema.js';
import { isBlank, serializeDoc, type ComposerPayload } from './serialize.js';

export interface ComposerHandlers {
  /** Enter, Mod+Enter: send when idle; steer or queue while running. */
  submit(intent: 'send' | 'steer' | 'queue', payload: ComposerPayload): void;
  /** Esc while running. */
  stop(): void;
  /** `/` typed into an empty composer (the command list arrives with T37). */
  command(): void;
  /** `@` opened the mention picker. */
  mentionOpened(): void;
  /** A mention was inserted. */
  mentionChosen(mention: MentionData): void;
}

function emptyState(): EditorState {
  return EditorState.create({
    schema: composerSchema,
    plugins: [
      mentionPlugin(),
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
function pastePlainText(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (text !== '') {
    const paragraphs = text
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) =>
        composerSchema.node('paragraph', null, line === '' ? [] : [composerSchema.text(line)]),
      );
    view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)));
  }
  return true;
}

export function Composer({
  running,
  candidates,
  handlers,
}: {
  running: boolean;
  candidates: readonly MentionData[];
  handlers: ComposerHandlers;
}) {
  const mount = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The editor's callbacks are created once; they read the latest props through these refs.
  const latest = useRef({ running, candidates, handlers });
  latest.current = { running, candidates, handlers };
  const [mention, setMention] = useState<MentionState>(CLOSED_MENTION);

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
          case 'queue': {
            const payload = serializeDoc(state.doc);
            if (!isBlank(payload)) {
              latest.current.handlers.submit(intent, payload);
              clearCommand()(state, dispatch, view);
            }
            return true;
          }
          case null:
            return false;
        }
      };
    const keys = keydownHandler(
      Object.fromEntries(COMPOSER_KEYS.map((key) => [key, command(key)])),
    );

    const view = new EditorView(element, {
      state: emptyState(),
      attributes: {
        class: 'composer-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Message',
        'data-testid': 'composer-input',
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        setMention(mentionKey.getState(next) ?? CLOSED_MENTION);
      },
      handleDOMEvents: {
        // Input method guard, ahead of everything ProseMirror does with a key: returning true
        // skips its keydown handling (key bindings, base keymap, plugins) without
        // preventDefault, so the key goes to the input method untouched. This also covers
        // keyCode 229 keys that arrive before compositionstart, when ProseMirror itself does
        // not consider the editor composing yet.
        keydown: (editor, event) => isImeComposing(event, editor.composing),
      },
      handleKeyDown(editor, event) {
        if (isImeComposing(event, editor.composing)) {
          return false;
        }
        const picker = mentionKey.getState(editor.state) ?? CLOSED_MENTION;
        if (picker.active) {
          const matches = matchCandidates(latest.current.candidates, picker.query);
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
              return true;
            }
            case 'Escape':
              editor.dispatch(closeMention(editor.state));
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
          latest.current.handlers.command();
        }
        return false;
      },
      handlePaste: (editor, event) => pastePlainText(editor, event),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  const matches = mention.active ? matchCandidates(candidates, mention.query) : [];
  const highlighted =
    matches.length === 0
      ? -1
      : ((mention.index % matches.length) + matches.length) % matches.length;
  return (
    <div className="composer" data-testid="composer" data-running={running}>
      {mention.active ? (
        <ul className="mention-popup" role="listbox" data-testid="mention-popup" aria-label="Files">
          {matches.length === 0 ? (
            <li className="mention-empty">No matching files</li>
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
      <div ref={mount} className="composer-mount" />
      <div className="composer-hint" aria-live="polite">
        {running
          ? 'Enter to steer · Mod+Enter to queue · Esc to stop'
          : 'Enter to send · Shift+Enter for a new line · @ to mention a file'}
      </div>
    </div>
  );
}
