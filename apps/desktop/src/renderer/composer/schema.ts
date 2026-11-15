// The composer's ProseMirror schema: paragraphs of text and mention chips. A mention keeps three
// things apart (architecture section 8.2): its data (the node's attributes), what the user
// sees (the chip, `@label`), and what is sent (`@path`, see serialize.ts).
import { Schema, type Node } from 'prosemirror-model';

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
  },
});

/** The data of a mention node. */
export function mentionOf(node: Node): MentionData {
  const { id, label, path } = node.attrs;
  if (typeof id !== 'string' || typeof label !== 'string' || typeof path !== 'string') {
    throw new TypeError('A mention node lost its attributes');
  }
  return { id, label, path };
}
