// A changed file's hunks in the Changes panel (T28): line numbers, signs and syntax colors from
// the highlight worker (each hunk's lines highlighted as one block in the file's language), and a
// discard button per hunk. Lines are text nodes and tokens; nothing is parsed as HTML.
import type { DiffHunk } from '@piarc/protocol';
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { Token } from '../transcript/highlight/CodeBlock.js';
import type { HighlightClient } from '../transcript/highlight/highlight-client.js';
import type { HighlightLines } from '../transcript/highlight/protocol.js';
import { useDarkScheme } from '../transcript/use-color-scheme.js';

/** The highlighted lines of `code`, once the worker answered (`null`: plain). */
function useHighlighted(
  highlight: HighlightClient,
  language: string | null,
  code: string,
): HighlightLines | null | undefined {
  const [result, setResult] = useState<{ code: string; lines: HighlightLines | null }>();
  useEffect(() => {
    let active = true;
    highlight.highlight(language, code).then(
      (lines) => {
        if (active) setResult({ code, lines });
      },
      (error: unknown) => {
        console.error('[changes] highlighting failed', error);
      },
    );
    return () => {
      active = false;
    };
  }, [highlight, language, code]);
  if (result?.code === code) return result.lines;
  return highlight.peek(language, code);
}

function Hunk({
  hunk,
  index,
  language,
  highlight,
  onDiscard,
  busy,
}: {
  readonly hunk: DiffHunk;
  readonly index: number;
  readonly language: string | null;
  readonly highlight: HighlightClient;
  readonly onDiscard: ((index: number) => void) | undefined;
  readonly busy: boolean;
}) {
  const t = useT();
  const dark = useDarkScheme();
  const lines = useHighlighted(highlight, language, hunk.lines.map((l) => l.text).join('\n'));
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <tbody className="diff-hunk" data-testid="changes-hunk" data-index={index}>
      <tr className="diff-hunk-head">
        <td colSpan={3}>
          <span className="changes-hunk-range">
            @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </span>
          {onDiscard === undefined ? null : (
            <button
              type="button"
              className="row-action changes-hunk-discard"
              data-testid="changes-discard-hunk"
              disabled={busy}
              onClick={() => {
                onDiscard(index);
              }}
            >
              {t('changes.discardHunk')}
            </button>
          )}
        </td>
      </tr>
      {hunk.lines.map((line, at) => {
        const old = line.kind === 'added' ? '' : String(oldLine++);
        const now = line.kind === 'removed' ? '' : String(newLine++);
        const tokens = lines?.[at];
        return (
          <tr key={at} className={`diff-line is-${line.kind}`} data-kind={line.kind}>
            <td className="diff-gutter">{old}</td>
            <td className="diff-gutter">{now}</td>
            <td className="diff-text">
              <span className="diff-sign" aria-hidden="true">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
              </span>
              {tokens === undefined
                ? line.text
                : tokens.map((token, i) => <Token key={i} token={token} dark={dark} />)}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

export function DiffBody({
  hunks,
  language,
  highlight,
  onDiscard,
  busy,
}: {
  readonly hunks: readonly DiffHunk[];
  readonly language: string | null;
  readonly highlight: HighlightClient;
  /** Discards hunk `index`; absent when hunks cannot be discarded. */
  readonly onDiscard: ((index: number) => void) | undefined;
  readonly busy: boolean;
}) {
  return (
    <div className="diff changes-diff" data-testid="changes-diff" data-highlight={language ?? ''}>
      <table className="diff-table">
        {hunks.map((hunk, index) => (
          <Hunk
            key={`${String(hunk.newStart)}:${String(index)}`}
            hunk={hunk}
            index={index}
            language={language}
            highlight={highlight}
            onDiscard={onDiscard}
            busy={busy}
          />
        ))}
      </table>
    </div>
  );
}
