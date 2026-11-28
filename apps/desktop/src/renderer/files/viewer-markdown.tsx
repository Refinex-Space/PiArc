import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useT } from '../app/app-context.js';
import { useSession, useStore } from '../store/hooks.js';
import { useUi } from '../shell/ui.js';
import { TranscriptContext } from '../transcript/services.js';
import { MarkdownView, DocumentElements } from '../transcript/markdown/MarkdownView.js';
import type { ListItem } from '../transcript/markdown/ir.js';
import { parentPath, projectFileRoot } from './file-path.js';
import { MarkdownImage } from './markdown/MarkdownImage.js';
import { markdownRichBlock } from './markdown/RichBlock.js';
import { useParsedDocument, type ParsedDocument } from './markdown/use-parsed-document.js';
import { taskMarker } from './markdown/task-marker.js';
import type { DocumentBlock } from './markdown/document-model.js';

export interface MarkdownReaderHandle {
  scrollToLine: (line: number) => void;
}
interface Props {
  sessionId: string;
  path: string;
  text: string;
  revision?: string;
  onChange?: (s: string) => void;
  onScrollLine?: (line: number) => void;
  readerRef?: RefObject<MarkdownReaderHandle | null>;
}
function anchorKey(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
const Chapter = memo(function Chapter({ entry }: { entry: DocumentBlock }) {
  const t = useT();
  return (
    <section
      className="markdown-section"
      data-doc-line={entry.line}
      data-end-line={entry.end}
      data-anchor={entry.anchor}
    >
      {entry.callout && entry.block.kind === 'blockquote' ? (
        <aside className={'markdown-callout is-' + entry.callout}>
          <strong>{entry.calloutTitle ?? t(`files.md.callout.${entry.callout}`)}</strong>
          <MarkdownView blocks={entry.block.blocks} />
        </aside>
      ) : (
        <MarkdownView blocks={[entry.block]} />
      )}
    </section>
  );
});
export function FileMarkdown(props: Props) {
  const parsed = useParsedDocument(props.text);
  return <MarkdownReader {...props} parsed={parsed} />;
}

export function MarkdownReader({
  parsed,
  sessionId,
  path,
  text,
  onChange,
  onScrollLine,
  readerRef,
}: Props & { parsed: ParsedDocument | undefined }) {
  const { transcriptServices: services } = useUi(),
    store = useStore(),
    t = useT();
  const root = projectFileRoot(useSession(sessionId)),
    element = useRef<HTMLDivElement>(null);
  const model = parsed?.document;
  const [limit, setLimit] = useState(64),
    [pendingAnchor, setAnchor] = useState<string>(),
    group = useId();
  const suppressed = useRef(false),
    frame = useRef<number | undefined>(undefined),
    pendingLine = useRef<number | undefined>(undefined);
  const safeReveal = useCallback((selector: string) => {
    const host = element.current,
      entry = host?.querySelector<HTMLElement>(selector);
    if (!entry || !host) return false;
    suppressed.current = true;
    host.scrollTop += entry.getBoundingClientRect().top - host.getBoundingClientRect().top - 12;
    host.ownerDocument.defaultView?.requestAnimationFrame(() => {
      suppressed.current = false;
    });
    return true;
  }, []);
  const go = useCallback(
    (name: string) => {
      const id = anchorKey(name);
      if (!safeReveal('[data-anchor="' + CSS.escape(id) + '"]')) {
        setLimit(model?.blocks.length ?? 64);
        setAnchor(id);
      }
    },
    [model, safeReveal],
  );
  const sync = useCallback(
    (line: number) => {
      if (!model?.blocks.length) {
        pendingLine.current = line;
        return;
      }
      let low = 0,
        high = model.blocks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((model.blocks[mid]?.line ?? 0) <= line) low = mid + 1;
        else high = mid;
      }
      const i = Math.max(0, low - 1),
        block = model.blocks[i];
      if (block && !safeReveal('[data-doc-line="' + String(block.line) + '"]')) {
        pendingLine.current = line;
        setLimit((n) => Math.max(n, i + 32));
      }
    },
    [model, safeReveal],
  );
  useLayoutEffect(() => {
    if (!readerRef) return;
    readerRef.current = { scrollToLine: sync };
    return () => {
      readerRef.current = null;
    };
  }, [sync, readerRef]);
  useLayoutEffect(() => {
    if (pendingAnchor) {
      safeReveal('[data-anchor="' + CSS.escape(pendingAnchor) + '"]');
      setAnchor(undefined);
    }
    if (pendingLine.current !== undefined && model) {
      const line = pendingLine.current;
      pendingLine.current = undefined;
      sync(line);
    }
  }, [limit, model, pendingAnchor, safeReveal, sync]);
  useEffect(() => {
    if (!model || limit >= model.blocks.length) return;
    const id = window.requestIdleCallback(
      () => {
        setLimit((n) => n + 64);
      },
      { timeout: 160 },
    );
    return () => {
      window.cancelIdleCallback(id);
    };
  }, [model, limit]);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const view = useMemo(
    () => ({
      services,
      fileLinks: { sessionId, root, directory: parentPath(path), document: path },
      transcript: store.transcript(sessionId),
      actions: { retry: () => undefined, resend: () => undefined },
    }),
    [services, root, path, sessionId, store],
  );
  const sourceLines = useMemo(() => text.split(/\r\n|\r|\n/u), [text]);
  const elements = useMemo(
    () => ({
      image: (src: string, alt: string) => (
        <MarkdownImage sessionId={sessionId} path={path} source={src} alt={alt} />
      ),
      rich: markdownRichBlock,
      anchor: go,
      anchorId: (label: string) => group + encodeURIComponent(label),
      checked: (item: ListItem) => {
        const line = item.sourceLine === undefined ? undefined : sourceLines[item.sourceLine - 1];
        const marker = line === undefined ? null : taskMarker.exec(line);
        return marker ? marker[2] !== ' ' : item.checked === true;
      },
      ...(onChange && parsed?.source === text
        ? {
            task: (item: ListItem) => {
              if (!item.sourceLine) return;
              const lines = text.split(/(\r\n|\n|\r)/u),
                index = (item.sourceLine - 1) * 2;
              const line = lines[index],
                match = line === undefined ? undefined : taskMarker.exec(line);
              if (!line || !match?.[1]) return;
              const at = match[1].length;
              lines[index] =
                line.slice(0, at) + (match[2] === ' ' ? 'x' : ' ') + line.slice(at + 1);
              onChange(lines.join(''));
            },
          }
        : {}),
    }),
    [path, sessionId, go, onChange, text, parsed?.source, sourceLines, group],
  );
  const scrolled = () => {
    if (!onScrollLine || suppressed.current || frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const host = element.current;
      if (!host || suppressed.current) return;
      const entries = host.querySelectorAll<HTMLElement>('[data-doc-line]'),
        top = host.getBoundingClientRect().top;
      let lo = 0,
        hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entries.item(mid).getBoundingClientRect().bottom <= top) lo = mid + 1;
        else hi = mid;
      }
      const line = entries[Math.min(lo, entries.length - 1)]?.dataset.docLine;
      if (line) onScrollLine(Number(line));
    });
  };
  return (
    <TranscriptContext.Provider value={view}>
      <DocumentElements.Provider value={elements}>
        <div
          ref={element}
          className="file-document file-prose markdown-reader"
          data-testid="markdown-reader"
          aria-busy={!model && !parsed?.error}
          onScroll={scrolled}
        >
          <article>
            {model?.fields.length ? (
              <dl className="file-frontmatter">
                {model.fields.map(([label, value], i) => (
                  <div key={i}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {model?.plain || parsed?.error ? (
              <>
                <small>{parsed?.error ?? t('files.viewer.plain')}</small>
                <pre>{text}</pre>
              </>
            ) : !text.trim() ? (
              <p className="muted">{t('files.viewer.empty')}</p>
            ) : model ? (
              model.blocks.slice(0, limit).map((entry, i) => <Chapter key={i} entry={entry} />)
            ) : (
              <span role="status">{t('files.viewer.loading')}</span>
            )}
            {model && model.notes.length > 0 && (
              <footer className="markdown-notes" aria-labelledby={group}>
                <h2 id={group}>{t('files.md.footnotes')}</h2>
                <ol>
                  {model.notes.map((note) => (
                    <li
                      key={note.label}
                      id={group + encodeURIComponent('fn-' + note.label)}
                      data-anchor={'fn-' + note.label}
                    >
                      <MarkdownView blocks={note.blocks} />
                      <button
                        type="button"
                        className="markdown-anchor"
                        aria-label={t('files.md.backToNote', { number: note.number })}
                        onClick={() => {
                          go('fnref-' + note.label);
                        }}
                      >
                        ↩
                      </button>
                    </li>
                  ))}
                </ol>
              </footer>
            )}
          </article>
        </div>
      </DocumentElements.Provider>
    </TranscriptContext.Provider>
  );
}
