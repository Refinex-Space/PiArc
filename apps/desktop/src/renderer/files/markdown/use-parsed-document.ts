import { useEffect, useRef, useState } from 'react';
import type { MarkdownDocument } from './document-model.js';
import type { ParseReply } from './document.worker.js';
// One worker for the visible tab. Coalesce drafts while typing, keep the previous document
// on screen, and never paint an older parse after a newer one.
export function useParsedDocument(text: string) {
  const [result, setResult] = useState<{
    document?: MarkdownDocument;
    error?: string;
    source: string;
  }>();
  const sequence = useRef(0),
    worker = useRef<Worker | null>(null);
  const latest = useRef(text);
  latest.current = text;
  const busy = useRef(false);
  const send = (source: string) => {
    if (!worker.current) return;
    busy.current = true;
    worker.current.postMessage({ sequence: ++sequence.current, text: source });
  };
  const sent = useRef<string | undefined>(undefined);
  useEffect(() => {
    const instance = new Worker(new URL('./document.worker.ts', import.meta.url), {
      type: 'module',
      name: 'piarc-file-markdown',
    });
    worker.current = instance;
    sent.current = undefined;
    busy.current = false;
    instance.onmessage = (e: MessageEvent<ParseReply>) => {
      if (e.data.sequence !== sequence.current) return;
      busy.current = false;
      const source = sent.current;
      if (source !== undefined && source === latest.current) setResult({ ...e.data, source });
      else {
        sent.current = latest.current;
        send(sent.current);
      }
    };
    instance.onerror = (e) => {
      busy.current = false;
      setResult({ source: latest.current, error: e.message });
    };
    return () => {
      sequence.current++;
      worker.current = null;
      instance.terminate();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!busy.current && sent.current !== text) {
        sent.current = text;
        send(text);
      }
    }, 60);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
  return result;
}
