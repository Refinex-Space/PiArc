import { memo, startTransition, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useT } from '../app/app-context.js';
import { useUi } from '../shell/ui.js';
import { projectFileRoot } from './navigation.js';
import { parentPath } from './file-path.js';
import { useStore, useSession } from '../store/hooks.js';
import { TranscriptContext } from '../transcript/services.js';
import { MarkdownView } from '../transcript/markdown/MarkdownView.js';
import type { Block } from '../transcript/markdown/ir.js';

// Avoid sending adversarially long lines or giant markdown tables to the same worker that renders chat replies.
function markdownDocument(text: string) {
  if (text.length > 512 * 1024) return { body: text, plain: true };
  let column = 0,
    pipes = 0;
  for (const char of text) {
    column = char === '\n' ? 0 : column + 1;
    if (char === '|') pipes++;
    if (column > 32768 || pipes > 8000) return { body: text, plain: true };
  }
  const front = /^---[ \t]*\r?\n([\s\S]{1,8192}?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(text);
  const fields: (readonly [string, string])[] = [];
  if (front?.[1]) {
    for (const line of front[1].split(/\r?\n/u)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const row = /^([\w.-]+):[ \t]*(.*)$/u.exec(line);
      if (!row?.[1]) return { body: text, plain: false };
      fields.push([row[1], row[2] ?? '']);
    }
  }
  return {
    body: fields.length && front ? text.slice(front[0].length) : text,
    fields,
    plain: false,
  };
}

const MarkdownPages = memo(function MarkdownPages({ blocks }: { blocks: readonly Block[] }) {
  const batches = useMemo(() => {
    const result: Block[][] = [];
    for (let i = 0; i < blocks.length; i += 48) result.push(blocks.slice(i, i + 48));
    return result;
  }, [blocks]);
  const [count, setCount] = useState(1);
  useEffect(() => {
    if (count >= batches.length) return;
    const id = window.requestIdleCallback(
      () => {
        startTransition(() => {
          setCount((n) => n + 1);
        });
      },
      { timeout: 100 },
    );
    return () => {
      window.cancelIdleCallback(id);
    };
  }, [batches, count]);
  return batches.slice(0, count).map((block, i) => (
    <div key={i} className="file-markdown-chunk">
      <MarkdownView blocks={block} />
    </div>
  ));
});

export function FileMarkdown({
  sessionId,
  path,
  text,
  revision,
}: {
  sessionId: string;
  path: string;
  text: string;
  revision: string;
}) {
  const { transcriptServices: services } = useUi(),
    store = useStore(),
    t = useT();
  const fileRoot = projectFileRoot(useSession(sessionId));
  const [id] = useState(() => crypto.randomUUID());
  const doc = useMemo(() => markdownDocument(text), [text]);
  const key = 'file-markdown/' + id + '/' + revision;
  const { markdown } = services;
  const parsed = useSyncExternalStore(
    (listener) => markdown.subscribe(key, listener),
    () => markdown.get(key),
  );
  useEffect(() => {
    if (!doc.plain) markdown.parseFinished(key, doc.body);
    return () => {
      markdown.drop([key]);
    };
  }, [markdown, key, doc]);
  const view = useMemo(
    () => ({
      services,
      fileLinks: { sessionId, root: fileRoot, directory: parentPath(path), document: path },
      transcript: store.transcript(sessionId),
      actions: { retry: () => undefined, resend: () => undefined },
    }),
    [services, store, sessionId, fileRoot, path],
  );
  if (!text.trim())
    return (
      <div className="tool-empty" role="status">
        {t('files.viewer.empty')}
      </div>
    );
  return (
    <TranscriptContext.Provider value={view}>
      <div className="file-document file-prose" aria-busy={!doc.plain && !parsed}>
        {doc.fields && doc.fields.length > 0 && (
          <dl className="file-frontmatter">
            {doc.fields.map(([label, value], i) => (
              <div key={i}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {doc.plain ? (
          <>
            <small>{t('files.viewer.plain')}</small>
            <pre>{doc.body}</pre>
          </>
        ) : parsed ? (
          <MarkdownPages key={key} blocks={parsed.blocks} />
        ) : (
          <span role="status">{t('files.viewer.loading')}</span>
        )}
      </div>
    </TranscriptContext.Provider>
  );
}
