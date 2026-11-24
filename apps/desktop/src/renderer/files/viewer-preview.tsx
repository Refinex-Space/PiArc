// All file text is display data. HTML previews retain document structure but never attach supplied
// attributes, scripts, styles or active content to the workbench document.
import { createElement, useMemo, type ReactNode } from 'react';
import { useT } from '../app/app-context.js';
import { FileMarkdown } from './viewer-markdown.js';
import { htmlPresentation, type HtmlPart } from './viewer-html.js';
import { parseTable, previewKind } from './viewer-model.js';
import type { ProjectFile } from './api.js';
import { DocumentFrame } from './DocumentFrame.js';

function FileTable({ text, delimiter }: { text: string; delimiter: string }) {
  const t = useT();
  const { rows, truncated, invalid } = useMemo(
    () => parseTable(text, delimiter),
    [text, delimiter],
  );
  if (invalid || !rows.length)
    return (
      <div className="tool-empty" role="status">
        <p>{t(invalid ? 'files.viewer.invalidTable' : 'files.viewer.empty')}</p>
      </div>
    );
  return (
    <div className="file-document file-table-wrap">
      <table aria-label={t('files.viewer.table')}>
        <thead>
          <tr>
            {rows[0]?.map((cell, col) => (
              <th key={col} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, index) => (
            <tr key={index}>
              {row.map((cell, col) => (
                <td key={col}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p role="status">{t('files.viewer.tableLimit')}</p>}
    </div>
  );
}

function htmlChildren(parts: HtmlPart[], onOpenFile?: (path: string) => void): ReactNode {
  return parts.map((part, key) => {
    if (typeof part === 'string') return part;
    if (part.tag === 'a') {
      if (part.local && onOpenFile) {
        const local = part.local;
        return (
          <button
            type="button"
            className="file-document-link"
            key={key}
            onClick={() => {
              onOpenFile(local);
            }}
          >
            {htmlChildren(part.children, onOpenFile)}
          </button>
        );
      }
      const href = part.href;
      if (!href) return <span key={key}>{htmlChildren(part.children, onOpenFile)}</span>;
      return (
        <a
          key={key}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            void window.piarc.openExternal(href).catch((error: unknown) => {
              console.error('[files] opening a link failed', error);
            });
          }}
        >
          {htmlChildren(part.children, onOpenFile)}
        </a>
      );
    }
    return createElement(
      part.tag,
      { key },
      part.tag === 'br' || part.tag === 'hr' ? undefined : htmlChildren(part.children, onOpenFile),
    );
  });
}

function HtmlPreview({
  text,
  path,
  onOpenFile,
}: {
  text: string;
  path: string;
  onOpenFile?: (path: string) => void;
}) {
  const content = useMemo(
    () => htmlChildren(htmlPresentation(text, path), onOpenFile),
    [text, path, onOpenFile],
  );
  return <div className="file-document file-prose">{content}</div>;
}

export function FilePreview({
  sessionId,
  file,
  onOpenFile,
}: {
  sessionId: string;
  file: ProjectFile;
  onOpenFile?: (path: string) => void;
}) {
  const kind = previewKind(file.path);
  const text = file.text ?? '';
  if (
    file.kind === 'image' ||
    file.kind === 'audio' ||
    file.kind === 'video' ||
    file.kind === 'pdf'
  )
    return <DocumentFrame sessionId={sessionId} path={file.path} kind={file.kind} />;
  switch (kind) {
    case 'markdown':
      return (
        <FileMarkdown
          sessionId={sessionId}
          path={file.path}
          text={text}
          revision={file.revision ?? ''}
        />
      );
    case 'csv':
    case 'tsv':
      return <FileTable text={text} delimiter={kind === 'csv' ? ',' : '\t'} />;
    case 'svg':
      return (
        <div className="file-media">
          <img
            alt={file.path}
            src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)}
          />
        </div>
      );
    case 'html':
      return (
        <DocumentFrame sessionId={sessionId} path={file.path} kind="html" text={text}>
          <HtmlPreview text={text} path={file.path} {...(onOpenFile ? { onOpenFile } : {})} />
        </DocumentFrame>
      );
    default:
      return null;
  }
}
