// The composer's ProseMirror schema: paragraphs of text, mention chips and snippet chips (text
// the user attached, such as a terminal selection, T34). A chip keeps three things apart
// (architecture section 8.2): its data (the node's attributes), what the user sees (the chip:
// `@label`, or the snippet's label), and what is sent (`@path`, or the snippet's text in a
// fenced block; see serialize.ts).
import { Schema, type Node } from 'prosemirror-model';

/** The data a snippet chip stores (T34: text selected in a terminal). */
export interface SnippetData {
  /** What the chip shows. */
  readonly label: string;
  /** Where the text came from, written above it in the message (`Terminal zsh`). */
  readonly source: string;
  /** The text itself. */
  readonly text: string;
}

/** The data a mention stores. */
export interface MentionData {
  /** Stable id of the candidate (for example the file's workspace-relative path). */
  readonly id: string;
  /** What the chip shows after the `@`. */
  readonly label: string;
  /** Workspace-relative path; what the sent text carries. */
  readonly path: string;
}

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    mention: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: false,
      attrs: {
        id: { validate: 'string' },
        label: { validate: 'string' },
        path: { validate: 'string' },
      },
      toDOM: (node) => [
        'span',
        {
          class: 'mention-chip',
          'data-piarc-mention': mentionOf(node).id,
          title: mentionOf(node).path,
          contenteditable: 'false',
        },
        `@${mentionOf(node).label}`,
      ],
    },
    snippet: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: false,
      attrs: {
        label: { validate: 'string' },
        source: { validate: 'string' },
        text: { validate: 'string' },
      },
      toDOM: (node) => [
        'span',
        {
          class: 'mention-chip snippet-chip',
          'data-piarc-snippet': snippetOf(node).source,
          title: snippetOf(node).text.slice(0, 2000),
          contenteditable: 'false',
        },
        snippetOf(node).label,
      ],
    },
  },
});

/** The data of a snippet node. */
export function snippetOf(node: Node): SnippetData {
  const { label, source, text } = node.attrs;
  if (typeof label !== 'string' || typeof source !== 'string' || typeof text !== 'string') {
    throw new TypeError('A snippet node lost its attributes');
  }
  return { label, source, text };
}

/** The data of a mention node. */
export function mentionOf(node: Node): MentionData {
  const { id, label, path } = node.attrs;
  if (typeof id !== 'string' || typeof label !== 'string' || typeof path !== 'string') {
    throw new TypeError('A mention node lost its attributes');
  }
  return { id, label, path };
}
