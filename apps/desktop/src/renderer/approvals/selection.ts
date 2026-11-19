// Where a selection lies in a text rendered as text nodes and inline marks (the plan panel):
// offsets in UTF-16 code units from the start of `container`'s text, as JavaScript strings index.
// The container must hold exactly the text and nothing else (no labels between the text nodes).

/** Offset of a selection boundary within `container`'s text. */
function offsetOf(container: HTMLElement, node: Node, offset: number): number | undefined {
  if (!container.contains(node)) return undefined;
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The selected range of `container`'s text, or undefined when the selection is not inside it
 * or is empty. */
export function selectionRange(
  container: HTMLElement,
  range: Range,
): { start: number; end: number } | undefined {
  const start = offsetOf(container, range.startContainer, range.startOffset);
  const end = offsetOf(container, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined || start >= end) return undefined;
  return { start, end };
}
