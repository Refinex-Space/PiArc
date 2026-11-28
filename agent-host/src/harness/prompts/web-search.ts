// WebSearch's texts (T38, ADR-0055): the request of a native search and the tool result. PiArc's
// own wording (ADR-0006). After changing it, run `node scripts/dev/check-prompt-originality.mjs`.
import type { WebSearchSource } from '@piarc/protocol';

/** The system prompt of a native search's auxiliary request. */
export const NATIVE_SEARCH_SYSTEM =
  'You look things up for another assistant. Run exactly one web search with your search ' +
  'tool for the query you receive, word for word. Afterwards write two or three plain ' +
  'sentences on what the results cover. Do not add facts the results do not contain.';

/** The user message of a native search's auxiliary request. */
export function nativeSearchPrompt(query: string): string {
  return `Query: ${query}`;
}

/** The tool result: the numbered results with their addresses, then a reminder to name them. */
export function searchResultText(
  query: string,
  backend: string,
  sources: readonly WebSearchSource[],
  notes?: string,
): string {
  if (sources.length === 0) {
    return `${backend} found nothing for "${query}". Try other words, or fewer of them.`;
  }
  const lines = [`${backend} results for "${query}":`, ''];
  sources.forEach((source, n) => {
    lines.push(`${String(n + 1)}. ${source.title}`, `   ${source.url}`);
    if (source.snippet !== undefined && source.snippet !== '') {
      lines.push(`   ${source.snippet}`);
    }
  });
  if (notes !== undefined && notes.trim() !== '') {
    lines.push('', `Search notes: ${notes.trim()}`);
  }
  lines.push(
    '',
    'When you use any of these in your answer, give the addresses you relied on as a Sources list at its end.',
  );
  return lines.join('\n');
}

/** Why WebSearch cannot run now. */
export const NO_SEARCH_BACKEND =
  'Web search is unavailable: the current model has no built-in search and no search service ' +
  'is set up in PiArc settings. Continue without it, or ask the user to add one.';

/** A native search that the provider refused or could not run. */
export function nativeSearchFailed(reason: string): string {
  return `The model provider's web search failed (${reason}). Try again later or with another query.`;
}
