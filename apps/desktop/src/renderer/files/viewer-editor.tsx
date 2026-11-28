import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useFileHighlight } from './viewer-highlight.js';
import { Token } from '../transcript/highlight/CodeBlock.js';
import { useDarkScheme } from '../transcript/use-color-scheme.js';
import { revealBidi } from '../transcript/reveal.js';
import { useT } from '../app/app-context.js';
import {
  textSelection,
  indentSelection,
  type ViewerSettings,
  type FileSelection,
  type FindMatch,
} from './viewer-model.js';
import type { FileLocation } from './viewer-source.js';

export function FileEditor({
  path,
  lines,
  text,
  settings,
  location,
  match,
  onChange,
  onSelect,
}: {
  path: string;
  lines: readonly string[];
  text: string;
  settings: ViewerSettings;
  location: FileLocation | undefined;
  match: FindMatch | undefined;
  onChange: (text: string) => void;
  onSelect: (value: FileSelection | undefined) => void;
}) {
  const t = useT(),
    field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const hint = useId(),
    dark = useDarkScheme();
  const paint = text.length <= 80000 && lines.length <= 800 && revealBidi(text) === text;
  const tokens = useFileHighlight(path, paint ? text : '', true);
  const [composing, setComposing] = useState(false);
  const syncScroll = () => {
    if (mirror.current && field.current) {
      mirror.current.scrollTop = field.current.scrollTop;
      mirror.current.scrollLeft = field.current.scrollLeft;
    }
  };
  const [escapeTab, setEscapeTab] = useState(false);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const n = match?.line ?? location?.line ?? 1;
    let offset = 0;
    for (let line = 1; line < n; line++) {
      const end = el.value.indexOf('\n', offset);
      if (end === -1) break;
      offset = end + 1;
    }
    // Related transitions such as Find keep focus in their own input.
    if (!match) el.focus();
    const end = el.value.indexOf('\n', offset);
    const lineEnd = end === -1 ? el.value.length : end;
    const start = Math.min(lineEnd, offset + (match?.start ?? (location?.column ?? 1) - 1));
    const stop = match ? Math.min(lineEnd, offset + match.end) : start;
    el.setSelectionRange(start, stop);
    const lineHeight =
      Number.parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).lineHeight ?? '') || 20;
    const visibleLine = mirror.current?.children[n - 1];
    const lineTop =
      visibleLine && 'offsetTop' in visibleLine
        ? Number(visibleLine.offsetTop)
        : (n - 1) * lineHeight;
    el.scrollTop = Math.max(0, lineTop - el.clientHeight / 2);
    syncScroll();
  }, [location, match]);
  return (
    <div
      className="file-edit-surface"
      data-painted={paint && !composing}
      data-numbered={paint}
      data-wrap={settings.wordWrap}
      data-past={settings.scrollPastEnd}
      style={
        {
          '--file-number-width': String(String(lines.length).length) + 'ch',
          '--file-tab-width': String(settings.tabSize) + 'ch',
          tabSize: settings.tabSize,
        } as CSSProperties
      }
    >
      {paint && (
        <div ref={mirror} className="file-editor-mirror" aria-hidden="true">
          {lines.map((line, i) => {
            const spans = tokens?.[i];
            const indent = settings.indentGuides ? /^[ \t]+/u.exec(line)?.[0] : '';
            return (
              <div className="file-editor-line" data-number={i + 1} key={i}>
                {indent && <span className="file-indent-guide">{indent}</span>}
                {settings.showWhitespace && (
                  <span className="file-whitespace">
                    {line
                      .replace(/[^ \t]/gu, '\u00a0')
                      .replace(/ /gu, '·')
                      .replace(/\t/gu, '→\t')}
                  </span>
                )}
                {spans
                  ? spans.map((token, j) => <Token key={j} token={token} dark={dark} />)
                  : line}
              </div>
            );
          })}
        </div>
      )}
      {settings.tabIndents && (
        <span className="visually-hidden" id={hint}>
          {t('files.viewer.tabHint')}
        </span>
      )}
      <textarea
        aria-describedby={settings.tabIndents ? hint : undefined}
        onCompositionStart={() => {
          setComposing(true);
        }}
        onCompositionEnd={() => {
          setComposing(false);
        }}
        onScroll={syncScroll}
        onContextMenu={(event) => {
          const el = event.currentTarget;
          if (el.selectionStart !== el.selectionEnd) return;
          const first =
            el.selectionStart === 0 ? 0 : el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
          const last = el.value.indexOf('\n', el.selectionEnd);
          const range = textSelection(el.value, first, last < 0 ? el.value.length : last);
          if (range) onSelect(range);
        }}
        className="file-editor"
        aria-label={t('files.viewer.editor')}
        ref={field}
        value={text}
        data-testid="file-editor"
        spellCheck={false}
        wrap={settings.wordWrap ? 'soft' : 'off'}
        style={{ tabSize: settings.tabSize }}
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
        onSelect={(event) => {
          const el = event.currentTarget;
          onSelect(textSelection(el.value, el.selectionStart, el.selectionEnd));
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            setEscapeTab(true);
            return;
          }
          if (
            event.key === 'Tab' &&
            settings.tabIndents &&
            !escapeTab &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            const el = event.currentTarget;
            const edit = indentSelection(
              el.value,
              el.selectionStart,
              el.selectionEnd,
              settings.tabSize,
              event.shiftKey,
            );
            if (!edit) return;
            event.preventDefault();
            el.setSelectionRange(edit.from, edit.to);
            // Chromium's insertText preserves the native textarea undo stack; setRangeText alone does not.
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- native undo for a single plain-text edit
            const performed = el.ownerDocument.execCommand('insertText', false, edit.insert);
            if (!performed) el.setRangeText(edit.insert, edit.from, edit.to, 'end');
            el.setSelectionRange(edit.start, edit.end);
            onChange(el.value);
          }
          setEscapeTab(false);
        }}
      />
    </div>
  );
}
