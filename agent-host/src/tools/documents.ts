// What `Read` returns for documents that are not plain text (architecture section 6.1.4): the
// text of a PDF's pages (extracted by Core, `fs/pdf`) and a Jupyter notebook as its cells with
// a summary of their outputs. Both are capped like Pi's text output (2000 lines or 50 KB), with
// a note on how to read less at a time.
import { truncateHead } from '@earendil-works/pi-coding-agent';
import type { FsPdfResult } from '@piarc/protocol';

/** Longest text kept of one cell output. */
const MAX_OUTPUT_CHARS = 2_000;

/** The pages of a PDF as text for the model. */
export function formatPdf(path: string, pdf: FsPdfResult): string {
  const first = pdf.pages[0]?.number;
  const last = pdf.pages.at(-1)?.number;
  const which =
    first === undefined || last === undefined
      ? 'no pages'
      : first === last
        ? `page ${String(first)}`
        : `pages ${String(first)}-${String(last)}`;
  const parts = [`PDF ${path}: ${String(pdf.pageCount)} pages; ${which} below.`];
  for (const page of pdf.pages) {
    const text = page.text.trim();
    parts.push(
      `--- Page ${String(page.number)} ---\n${text === '' ? '(no text on this page)' : text}`,
    );
  }
  return capped(parts.join('\n\n'), 'Read fewer pages at a time with the pages parameter.');
}

/** A notebook (`.ipynb` JSON) as its cells and output summaries, or an explanation. */
export function formatNotebook(path: string, json: string): string {
  let notebook: unknown;
  try {
    notebook = JSON.parse(json);
  } catch {
    throw new Error(`${path} is not a valid notebook: its content is not JSON.`);
  }
  if (!isRecord(notebook) || !Array.isArray(notebook.cells)) {
    throw new Error(`${path} is not a valid notebook: it has no cells list.`);
  }
  const language = notebookLanguage(notebook);
  const parts = [
    `Notebook ${path}: ${String(notebook.cells.length)} cells${language === undefined ? '' : `, language ${language}`}.`,
  ];
  notebook.cells.forEach((cell: unknown, index: number) => {
    parts.push(formatCell(cell, index + 1));
  });
  return capped(parts.join('\n\n'), 'Use Bash or Grep to look at parts of the notebook.');
}

function formatCell(cell: unknown, number: number): string {
  if (!isRecord(cell)) {
    return `[cell ${String(number)}: not a cell]`;
  }
  const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
  const id = typeof cell.id === 'string' ? ` id=${cell.id}` : '';
  const count =
    typeof cell.execution_count === 'number' ? `, run ${String(cell.execution_count)}` : '';
  const lines = [`[cell ${String(number)}${id}: ${type}${count}]`, joinSource(cell.source)];
  if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
    lines.push('[outputs]');
    for (const output of cell.outputs) {
      lines.push(summarizeOutput(output));
    }
  }
  return lines.join('\n');
}

function summarizeOutput(output: unknown): string {
  if (!isRecord(output)) {
    return '(unreadable output)';
  }
  switch (output.output_type) {
    case 'stream':
      return shorten(joinSource(output.text));
    case 'error': {
      const name = typeof output.ename === 'string' ? output.ename : 'Error';
      const value = typeof output.evalue === 'string' ? output.evalue : '';
      return `${name}: ${value}`;
    }
    case 'execute_result':
    case 'display_data': {
      const data = isRecord(output.data) ? output.data : {};
      const text = data['text/plain'];
      const kinds = Object.keys(data).filter((kind) => kind !== 'text/plain');
      const parts: string[] = [];
      if (text !== undefined) {
        parts.push(shorten(joinSource(text)));
      }
      if (kinds.length > 0) {
        parts.push(`[${kinds.join(', ')} output not shown]`);
      }
      return parts.length > 0 ? parts.join('\n') : '(empty output)';
    }
    default:
      return '(output of an unknown kind)';
  }
}

function notebookLanguage(notebook: Record<string, unknown>): string | undefined {
  const metadata = isRecord(notebook.metadata) ? notebook.metadata : {};
  const info = isRecord(metadata.language_info) ? metadata.language_info : {};
  if (typeof info.name === 'string') {
    return info.name;
  }
  const kernel = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  return typeof kernel.language === 'string' ? kernel.language : undefined;
}

/** Notebook text fields are a string or a list of strings. */
function joinSource(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    return source.filter((part): part is string => typeof part === 'string').join('');
  }
  return '';
}

function shorten(text: string): string {
  const trimmed = text.replace(/\n+$/, '');
  if (trimmed.length <= MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}… [${String(trimmed.length - MAX_OUTPUT_CHARS)} more characters]`;
}

/** `text` within Pi's read limits, with `advice` when it was cut. */
function capped(text: string, advice: string): string {
  const truncation = truncateHead(text);
  if (!truncation.truncated) {
    return text;
  }
  return `${truncation.content}\n\n[Output cut at ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines. ${advice}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
