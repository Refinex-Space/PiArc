// What the composer sends: the text with mentions spliced in as `@path`, the mentions' data,
// and the segments the transcript echoes back (text and chips).
import type { Node } from 'prosemirror-model';

import type { UserSegment } from '../transcript/item-store.js';
import { mentionOf, type MentionData } from './schema.js';

export interface ComposerPayload {
  /** The text for the model; paragraphs joined by newlines, mentions as `@path`. */
  readonly text: string;
  /** The mentions in order of appearance. */
  readonly mentions: readonly MentionData[];
  /** The display form: text runs and chips. */
  readonly segments: readonly UserSegment[];
}

export function serializeDoc(doc: Node): ComposerPayload {
  let text = '';
  const mentions: MentionData[] = [];
  const segments: UserSegment[] = [];
  const pushText = (value: string): void => {
    text += value;
    const last = segments.at(-1);
    if (last?.kind === 'text') {
      segments[segments.length - 1] = { kind: 'text', text: last.text + value };
    } else if (value !== '') {
      segments.push({ kind: 'text', text: value });
    }
  };
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) {
      pushText('\n');
    }
    paragraph.forEach((child) => {
      if (child.type.name === 'mention') {
        const mention = mentionOf(child);
        mentions.push(mention);
        text += `@${mention.path}`;
        segments.push({ kind: 'mention', label: mention.label, path: mention.path });
      } else {
        pushText(child.text ?? '');
      }
    });
  });
  return { text, mentions, segments };
}

/** True when there is nothing to send: only whitespace and no mentions. */
export function isBlank(payload: ComposerPayload): boolean {
  return payload.mentions.length === 0 && payload.text.trim() === '';
}
