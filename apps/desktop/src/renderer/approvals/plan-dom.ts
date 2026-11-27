// The plan panel's rendered blocks and the plan's source (ADR-0103): a selection becomes the
// UTF-16 source range it shows, and a comment's source range becomes the DOM ranges that mark
// it. Each block element carries `data-src-start` and `data-src-end` (its source lines as
// offsets); the mapping inside a block is `plan-source.ts`. Text the renderer adds (buttons,
// hidden labels) is not part of a block's text.
import { alignRendered, renderedRuns, sourceRange } from './plan-source.js';

/** A rendered block: its text nodes, where each starts in the block's text, and the mapping. */
interface BlockText {
  readonly nodes: readonly Text[];
  readonly starts: readonly number[];
  readonly length: number;
  readonly map: Int32Array;
}

const SKIP = 'button, input, select, textarea, svg, [aria-hidden="true"], [data-plan-skip]';

function textNodes(block: Element): Text[] {
  const doc = block.ownerDocument;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const skipped = node.parentElement?.closest(SKIP);
      return skipped === null || skipped === undefined || !block.contains(skipped)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  return nodes;
}

/** The source range a block element shows, from its data attributes. */
export function blockSource(block: Element): { start: number; end: number } | undefined {
  const start = Number(block.getAttribute('data-src-start'));
  const end = Number(block.getAttribute('data-src-end'));
  return Number.isInteger(start) && Number.isInteger(end) && start <= end
    ? { start, end }
    : undefined;
}

/** A block's text, read from the DOM each time: code highlighting replaces text nodes later. */
function blockText(block: Element, plan: string): BlockText | undefined {
  const source = blockSource(block);
  if (source === undefined) return undefined;
  const nodes = textNodes(block);
  const starts: number[] = [];
  let length = 0;
  let rendered = '';
  for (const node of nodes) {
    starts.push(length);
    length += node.data.length;
    rendered += node.data;
  }
  return {
    nodes,
    starts,
    length,
    map: alignRendered(rendered, plan.slice(source.start, source.end), source.start),
  };
}

/** Where a range boundary lies in a block's text. */
function indexOf(text: BlockText, node: Node, offset: number): number {
  const doc = node.ownerDocument;
  if (doc === null) return 0;
  const at = doc.createRange();
  at.setStart(node, offset);
  for (const [k, candidate] of text.nodes.entries()) {
    const start = text.starts[k] ?? 0;
    if (candidate === node) return start + Math.min(offset, candidate.data.length);
    // The candidate starts after the boundary: the boundary is just before it.
    if (at.comparePoint(candidate, 0) === 1) return start;
  }
  return text.length;
}

/** The DOM position of index `at` of a block's text (at the end of the text before a gap). */
function pointAt(text: BlockText, at: number, end: boolean): { node: Text; offset: number } {
  for (const [k, node] of text.nodes.entries()) {
    const start = text.starts[k] ?? 0;
    const stop = start + node.data.length;
    if (end ? at <= stop : at < stop) return { node, offset: at - start };
  }
  const last = text.nodes.at(-1);
  if (last === undefined) throw new Error('A rendered block without text');
  return { node: last, offset: last.data.length };
}

function blockOf(node: Node, root: Element): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest('[data-src-start]') ?? null;
  return block !== null && root.contains(block) ? block : null;
}

/** The blocks under `root`, in document order. */
function blocksOf(root: Element): Element[] {
  return [...root.querySelectorAll('[data-src-start]')];
}

/**
 * The source range of `plan` that a selection `range` inside `root` shows, or undefined when it
 * shows none (outside the plan, empty, or only text the renderer added).
 */
export function selectionToSource(
  root: Element,
  range: Range,
  plan: string,
): { start: number; end: number } | undefined {
  const blocks = blocksOf(root).filter((block) => range.intersectsNode(block));
  const first = blocks[0];
  const last = blocks.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const firstText = blockText(first, plan);
  const lastText = blockText(last, plan);
  if (firstText === undefined || lastText === undefined) return undefined;
  const from =
    blockOf(range.startContainer, root) === first
      ? indexOf(firstText, range.startContainer, range.startOffset)
      : 0;
  const to =
    blockOf(range.endContainer, root) === last
      ? indexOf(lastText, range.endContainer, range.endOffset)
      : lastText.length;
  const start = sourceRange(firstText.map, from, first === last ? to : firstText.length)?.start;
  const end = sourceRange(lastText.map, first === last ? from : 0, to)?.end;
  return start === undefined || end === undefined || end <= start ? undefined : { start, end };
}

/** The DOM ranges under `root` that show source `[start, end)` of `plan`. */
export function sourceToRanges(root: Element, plan: string, start: number, end: number): Range[] {
  const ranges: Range[] = [];
  for (const block of blocksOf(root)) {
    const source = blockSource(block);
    if (source === undefined || source.end <= start || source.start >= end) continue;
    const text = blockText(block, plan);
    if (text === undefined || text.nodes.length === 0) continue;
    for (const run of renderedRuns(text.map, start, end)) {
      const from = pointAt(text, run.from, false);
      const to = pointAt(text, run.to, true);
      const range = block.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      ranges.push(range);
    }
  }
  return ranges;
}

/** The source offset of a point in the plan (a click), or undefined outside any block. */
export function pointToSource(
  root: Element,
  node: Node,
  offset: number,
  plan: string,
): number | undefined {
  const block = blockOf(node, root);
  const text = block === null ? undefined : blockText(block, plan);
  if (text === undefined) return undefined;
  const at = indexOf(text, node, offset);
  // The character under the point, or the one before it at the end of the text.
  return sourceRange(text.map, Math.min(at, text.length - 1), Math.min(at + 1, text.length))?.start;
}
