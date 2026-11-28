import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParseReply } from './document.worker.js';
type Scope = 'outline' | 'document' | false;
export type ParsedDocument = Omit<ParseReply, 'sequence'> & { source: string };
// The currently visible file owns one parser. Source/live modes transfer just headings.
// Switching to reading reuses the parsed text in the same worker.
export function useParsedDocument(text: string, scope: Scope = 'document') {
  const [result, setResult] = useState<ParsedDocument>();
  const request = useMemo(() => ({ text, scope }), [text, scope]),
    latest = useRef(request);
  latest.current = request;
  const submit = useRef<() => void>(undefined);
  const enabled = Boolean(scope);
  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(new URL('./document.worker.ts', import.meta.url), {
      type: 'module',
      name: 'piarc-file-markdown',
    });
    let sent: typeof request | undefined,
      busy = false,
      sequence = 0;
    const send = () => {
      const next = latest.current;
      if (!next.scope || busy || sent === next) return;
      sent = next;
      busy = true;
      worker.postMessage({
        sequence: ++sequence,
        text: next.text,
        outlineOnly: next.scope === 'outline',
      });
    };
    submit.current = send;
    worker.onmessage = (event: MessageEvent<ParseReply>) => {
      if (event.data.sequence !== sequence) return;
      busy = false;
      if (sent && sent === latest.current) setResult({ ...event.data, source: sent.text });
      else send();
    };
    worker.onerror = (e) => {
      busy = false;
      setResult({ source: latest.current.text, error: e.message });
    };
    return () => {
      submit.current = undefined;
      worker.terminate();
    };
  }, [enabled]);
  useEffect(() => {
    if (scope === false) return;
    const timer = setTimeout(() => submit.current?.(), scope === 'outline' ? 120 : 60);
    return () => {
      clearTimeout(timer);
    };
  }, [request, scope]);
  return enabled ? result : undefined;
}
