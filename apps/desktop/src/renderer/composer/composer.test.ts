// Composer logic without a DOM: the input method guard, key semantics, mention state and the
// three forms of a mention (data, display, sent text).
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { IME_PROCESS_KEY_CODE, isImeComposing } from './ime-guard.js';
import { COMPOSER_KEYS, intentFor } from './intents.js';
import {
  CLOSED_MENTION,
  chooseMention,
  closeMention,
  matchCandidates,
  mentionKey,
  mentionPlugin,
  openMention,
} from './mention-plugin.js';
import { composerSchema, type MentionData } from './schema.js';
import { isBlank, serializeDoc } from './serialize.js';
import { commandKey, commandPlugin, filterCommands, openCommands } from './command-plugin.js';

const README: MentionData = { id: 'readme', label: 'README.md', path: 'docs/README.md' };

function state(text = ''): EditorState {
  const paragraph = composerSchema.node(
    'paragraph',
    null,
    text === '' ? [] : [composerSchema.text(text)],
  );
  const created = EditorState.create({
    doc: composerSchema.node('doc', null, [paragraph]),
    plugins: [mentionPlugin()],
  });
  return created.apply(
    created.tr.setSelection(TextSelection.create(created.doc, created.doc.content.size - 1)),
  );
}

describe('isImeComposing', () => {
  it('flags composing key events, the Process key code and an editor in composition', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: IME_PROCESS_KEY_CODE })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 }, true)).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('intentFor', () => {
  it('maps keys to the idle and running semantics', () => {
    const table = Object.fromEntries(
      COMPOSER_KEYS.map((key) => [key, [intentFor(key, false), intentFor(key, true)]]),
    );
    expect(table).toEqual({
      Enter: ['send', 'steer'],
      'Shift-Enter': ['newline', 'newline'],
      'Mod-Enter': ['send', 'queue'],
      Escape: [null, 'stop'],
    });
  });
});

describe('mentions', () => {
  it('opens on @, follows the query and closes on whitespace', () => {
    let current = state('see ');
    const at = current.selection.head;
    current = current.apply(openMention(current, at, at));
    expect(mentionKey.getState(current)).toEqual({ active: true, from: at, query: '', index: 0 });
    current = current.apply(current.tr.insertText('REA'));
    expect(mentionKey.getState(current)?.query).toBe('REA');
    current = current.apply(current.tr.insertText(' '));
    expect(mentionKey.getState(current)).toEqual(CLOSED_MENTION);
  });

  it('closes when the @ is deleted or on request', () => {
    let current = state('x');
    const at = current.selection.head;
    current = current.apply(openMention(current, at, at));
    current = current.apply(current.tr.delete(at, at + 1));
    expect(mentionKey.getState(current)?.active).toBe(false);
    current = current.apply(openMention(current, at, at));
    current = current.apply(closeMention(current));
    expect(mentionKey.getState(current)?.active).toBe(false);
  });

  it('keeps data, display and sent text apart', () => {
    let current = state('read ');
    const at = current.selection.head;
    current = current.apply(openMention(current, at, at));
    current = current.apply(current.tr.insertText('rea'));
    current = current.apply(chooseMention(current, README));
    current = current.apply(current.tr.insertText('please'));
    const payload = serializeDoc(current.doc);
    // Sent text: the path; data: the full mention; display: a chip with the label.
    expect(payload.text).toBe('read @docs/README.md please');
    expect(payload.mentions).toEqual([README]);
    expect(payload.spans).toEqual([{ path: 'docs/README.md', start: 5, end: 20 }]);
    expect(payload.text.slice(5, 20)).toBe('@docs/README.md');
    const mentionNode = current.doc.firstChild?.child(1);
    expect(mentionNode?.type.name).toBe('mention');
    expect(mentionNode?.textContent).toBe('');
  });

  it('matches candidates on label or path, ignoring case', () => {
    const candidates = [README, { id: 'main', label: 'main.ts', path: 'src/main.ts' }];
    expect(matchCandidates(candidates, 'DOCS')).toEqual([README]);
    expect(matchCandidates(candidates, '')).toEqual(candidates);
  });
});

describe('serializeDoc', () => {
  it('joins paragraphs with newlines and recognizes blank input', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [composerSchema.text('one')]),
      composerSchema.node('paragraph'),
      composerSchema.node('paragraph', null, [composerSchema.text('two')]),
    ]);
    expect(serializeDoc(doc).text).toBe('one\n\ntwo');
    expect(isBlank(serializeDoc(state('   ').doc))).toBe(true);
    expect(isBlank(serializeDoc(doc))).toBe(false);
  });

  it('sends a snippet chip as its source and a fence its text cannot close (T34)', () => {
    const snippet = { label: 'zsh (2 lines)', source: 'Terminal zsh', text: 'a ``` b\nc' };
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [
        composerSchema.text('why?'),
        composerSchema.node('snippet', snippet),
      ]),
    ]);
    const payload = serializeDoc(doc);
    expect(payload.text).toBe('why?\nTerminal zsh:\n````text\na ``` b\nc\n````\n');
    expect(payload.mentions).toEqual([]);
    expect(
      isBlank(
        serializeDoc(
          composerSchema.node('doc', null, [
            composerSchema.node('paragraph', null, [composerSchema.node('snippet', snippet)]),
          ]),
        ),
      ),
    ).toBe(false);
  });
});

describe('command palette', () => {
  const COMMANDS = [
    { name: 'clear', description: '', source: 'builtIn', kind: 'builtIn' },
    { name: 'compact', description: '', source: 'builtIn', kind: 'builtIn' },
    { name: 'help', description: '', source: 'builtIn', kind: 'builtIn' },
  ];

  it('filters commands fuzzily, best first', () => {
    expect(filterCommands(COMMANDS, '').map((c) => c.name)).toEqual(['clear', 'compact', 'help']);
    expect(filterCommands(COMMANDS, 'cp').map((c) => c.name)).toEqual(['compact']);
    expect(filterCommands(COMMANDS, 'l').map((c) => c.name)).toEqual(['help', 'clear']);
    expect(filterCommands(COMMANDS, 'HE').map((c) => c.name)).toEqual(['help']);
  });

  it('groups by source in palette order and matches aliases and descriptions (T37)', () => {
    const mixed = [
      { name: 'deploy', description: 'Ship it', source: 'userClaude', kind: 'command' },
      { name: 'review', description: 'Review a diff', source: 'projectClaude', kind: 'command' },
      { name: 'greet', description: 'Say hello', source: 'projectPiarc', kind: 'skill' },
      { name: 'clear', description: '', source: 'builtIn', kind: 'builtIn', aliases: ['reset'] },
    ];
    expect(filterCommands(mixed, '').map((c) => c.source)).toEqual([
      'builtIn',
      'projectPiarc',
      'projectClaude',
      'userClaude',
    ]);
    expect(filterCommands(mixed, 'reset').map((c) => c.name)).toEqual(['clear']);
    expect(filterCommands(mixed, 'diff').map((c) => c.name)).toEqual(['review']);
  });

  it('opens on a typed slash, follows the query and closes on whitespace', () => {
    let current = EditorState.create({ schema: composerSchema, plugins: [commandPlugin()] });
    current = current.apply(openCommands(current, 1, 1));
    expect(commandKey.getState(current)).toMatchObject({ active: true, query: '' });
    current = current.apply(current.tr.insertText('co'));
    expect(commandKey.getState(current)).toMatchObject({ active: true, query: 'co' });
    current = current.apply(current.tr.insertText(' '));
    expect(commandKey.getState(current)?.active).toBe(false);
  });
});
