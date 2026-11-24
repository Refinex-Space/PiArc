import { useEffect, useState } from 'react';
import { languageOf } from '../changes/language.js';
import { useUi } from '../shell/ui.js';
import type { HighlightLines } from '../transcript/highlight/protocol.js';

export function useFileHighlight(path: string, text: string, editing = false) {
  const { transcriptServices } = useUi();
  const language = languageOf(path);
  const [value, setValue] = useState<{ text: string; lines: HighlightLines | null }>();
  useEffect(() => {
    if (!language || !text) return;
    let active = true;
    const highlight = () => {
      void transcriptServices.highlight.highlight(language, text).then(
        (lines) => {
          if (active) setValue({ text, lines });
        },
        (error: unknown) => {
          console.error('[files] highlighting failed', error);
        },
      );
    };
    const timer = editing ? setTimeout(highlight, 180) : undefined;
    if (timer === undefined) highlight();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [transcriptServices, language, text, editing]);
  return value?.text === text ? value.lines : undefined;
}
