// A fenced code block. While the fence is open the code shows as plain text; once complete it is
// highlighted in the worker and the tokens replace the text (architecture section 8.4). Tokens
// are React elements with colors set through the style object, never HTML.
import { memo, useEffect, useState } from 'react';

import { useRowCommitted } from '../rows/list-actions.js';
import { useTranscriptServices } from '../services.js';
import { useDarkScheme } from '../use-color-scheme.js';
import { HighlightClient } from './highlight-client.js';
import type { HighlightLines, HighlightToken } from './protocol.js';
import { revealBidi } from '../reveal.js';

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;

function tokenClass(fontStyle: number): string | undefined {
  const classes = [
    fontStyle & ITALIC ? 'hl-italic' : '',
    fontStyle & BOLD ? 'hl-bold' : '',
    fontStyle & UNDERLINE ? 'hl-underline' : '',
    fontStyle & STRIKETHROUGH ? 'hl-strike' : '',
  ].filter((name) => name !== '');
  return classes.length === 0 ? undefined : classes.join(' ');
}

/** One highlighted run of code (also used by the Changes panel's diff, T28). */
export function Token({ token, dark }: { token: HighlightToken; dark: boolean }) {
  const color = dark ? token.dark : token.light;
  return (
    <span className={tokenClass(token.fontStyle)} style={color === null ? undefined : { color }}>
      {revealBidi(token.text)}
    </span>
  );
}

function HighlightedCode({ lines }: { lines: HighlightLines }) {
  const dark = useDarkScheme();
  return lines.map((line, lineIndex) => (
    // Lines never reorder, so the index is a stable key.
    <span key={lineIndex} className="hl-line">
      {line.map((token, tokenIndex) => (
        <Token key={tokenIndex} token={token} dark={dark} />
      ))}
      {lineIndex < lines.length - 1 ? '\n' : null}
    </span>
  ));
}

type HighlightState = HighlightLines | null | undefined;

/** Highlighted lines once available; `null` for code that stays plain. */
function useHighlight(lang: string | null, code: string, complete: boolean): HighlightState {
  const { highlight } = useTranscriptServices();
  const supported = complete && HighlightClient.supports(lang, code);
  const [result, setResult] = useState<{ code: string; lines: HighlightState }>(() => ({
    code,
    lines: supported ? highlight.peek(lang, code) : null,
  }));
  useEffect(() => {
    if (!supported) {
      return;
    }
    let active = true;
    highlight.highlight(lang, code).then(
      (lines) => {
        if (active) {
          setResult({ code, lines });
        }
      },
      (error: unknown) => {
        console.error('[highlight] request failed', error);
      },
    );
    return () => {
      active = false;
    };
  }, [highlight, lang, code, supported]);
  if (!supported) {
    return null;
  }
  return result.code === code ? result.lines : highlight.peek(lang, code);
}

export const CodeBlock = memo(function CodeBlock({
  lang,
  code,
  complete,
}: {
  lang: string | null;
  code: string;
  complete: boolean;
}) {
  const lines = useHighlight(lang, code, complete);
  // Highlighting can change the block's height on its own: keep the bottom in view.
  useRowCommitted();
  const state = lines === undefined ? 'pending' : lines === null ? 'plain' : 'highlighted';
  return (
    <div
      className="md-code"
      data-testid="code-block"
      data-language={lang ?? ''}
      data-complete={complete ? 'true' : 'false'}
      data-highlight={state}
    >
      {lang === null ? null : (
        <div className="md-code-lang" aria-hidden="true">
          {lang}
        </div>
      )}
      <pre>
        <code>
          {lines === undefined || lines === null ? code : <HighlightedCode lines={lines} />}
        </code>
      </pre>
    </div>
  );
});
