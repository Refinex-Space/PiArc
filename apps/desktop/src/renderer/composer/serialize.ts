// What the composer sends (architecture section 8.2, ADR-0030): the text for the model with each
// mention spliced in as `@path`, where those mentions sit in the text (UTF-16 offsets, Core's
// unit), and the chips' own data. Data, display (the chip shows `@label`) and sent text stay
// apart.
import type { InputMention } from '@piarc/protocol';
import type { Node } from 'prosemirror-model';

import { commandOf, mentionOf, snippetOf, type MentionData } from './schema.js';

export interface ComposerPayload {
  /** The text for the model; paragraphs joined by newlines, mentions as `@path`. */
  readonly text: string;
  /** The chips' data, in order of appearance. */
  readonly mentions: readonly MentionData[];
  /** Where each mention's `@path` sits in `text`. */
  readonly spans: readonly InputMention[];
}

export function serializeDoc(doc: Node): ComposerPayload {
  let text = '';
  const mentions: MentionData[] = [];
  const spans: InputMention[] = [];
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) {
      text += '\n';
    }
    paragraph.forEach((child) => {
      if (child.type.name === 'snippet') {
        text += snippetText(snippetOf(child));
      } else if (child.type.name === 'command') {
        text += `/${commandOf(child).name}`;
      } else if (child.type.name === 'mention') {
        const mention = mentionOf(child);
        mentions.push(mention);
        const start = text.length;
        text += `@${mention.path}`;
        spans.push({ path: mention.path, start, end: text.length });
      } else {
        text += child.text ?? '';
      }
    });
  });
  return { text, mentions, spans };
}

/**
 * A snippet as sent: its source on a line of its own, then the text in a fenced block long
 * enough that backticks in the text cannot close it.
 */
export function snippetText(snippet: { readonly source: string; readonly text: string }): string {
  const longest = Math.max(2, ...[...snippet.text.matchAll(/`+/gu)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `\n${snippet.source}:\n${fence}text\n${snippet.text}\n${fence}\n`;
}

/** True when there is nothing to send: only whitespace and no mentions. */
export function isBlank(payload: ComposerPayload): boolean {
  return payload.mentions.length === 0 && payload.text.trim() === '';
}
