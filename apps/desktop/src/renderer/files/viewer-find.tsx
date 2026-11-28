import { useState, useEffect, type ReactNode } from 'react';
import { Button } from '../app/Button.js';
import { parseLocation } from './viewer-model.js';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { CloseIcon } from '../shell/icons.js';
import { NONE_FOUND, type FindOptions, type FindResult } from './viewer-model.js';

function FindGlyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const findIcons = {
  chevron: (
    <FindGlyph>
      <path d="m6 9 6 6 6-6" />
    </FindGlyph>
  ),
  caseSensitive: (
    <FindGlyph>
      <path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16" />
      <path d="M3.304 13h6.392" />
      <path d="M22 9v7" />
      <circle cx="18.5" cy="12.5" r="3.5" />
    </FindGlyph>
  ),
  wholeWord: (
    <FindGlyph>
      <circle cx="7" cy="12" r="3" />
      <path d="M10 9v6" />
      <circle cx="17" cy="12" r="3" />
      <path d="M14 7v8" />
      <path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1" />
    </FindGlyph>
  ),
  regex: (
    <FindGlyph>
      <path d="M17 3v10" />
      <path d="m12.67 5.5 8.66 5" />
      <path d="m12.67 10.5 8.66-5" />
      <path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z" />
    </FindGlyph>
  ),
  up: (
    <FindGlyph>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </FindGlyph>
  ),
  down: (
    <FindGlyph>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </FindGlyph>
  ),
  all: (
    <FindGlyph>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </FindGlyph>
  ),
  replace: (
    <FindGlyph>
      <path d="M14 4a1 1 0 0 1 1-1" />
      <path d="M15 10a1 1 0 0 1-1-1" />
      <path d="M21 4a1 1 0 0 0-1-1" />
      <path d="M21 9a1 1 0 0 1-1 1" />
      <path d="m3 7 3 3 3-3" />
      <path d="M6 10V5a2 2 0 0 1 2-2h2" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </FindGlyph>
  ),
  replaceAll: (
    <FindGlyph>
      <path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
      <path d="M14 4a1 1 0 0 1 1-1" />
      <path d="M15 10a1 1 0 0 1-1-1" />
      <path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
      <path d="M21 4a1 1 0 0 0-1-1" />
      <path d="M21 9a1 1 0 0 1-1 1" />
      <path d="m3 7 3 3 3-3" />
      <path d="M6 10V5a2 2 0 0 1 2-2h2" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </FindGlyph>
  ),
  close: (
    <FindGlyph>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </FindGlyph>
  ),
};

export function useFileFind(lines: readonly string[], query: string, options: FindOptions) {
  const [found, setFound] = useState<{
    query: string;
    lines: readonly string[];
    options: FindOptions;
    result: FindResult;
    timedOut?: boolean;
  }>();
  useEffect(() => {
    if (!query) return;
    const worker = new Worker(new URL('./viewer-find.worker.ts', import.meta.url), {
      type: 'module',
    });
    const timeout = setTimeout(() => {
      worker.terminate();
      setFound({ query, lines, options, result: NONE_FOUND, timedOut: true });
    }, 1200);
    worker.onmessage = (event: MessageEvent<FindResult>) => {
      clearTimeout(timeout);
      worker.terminate();
      setFound({ query, lines, options, result: event.data });
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      setFound({ query, lines, options, result: NONE_FOUND, timedOut: true });
    };
    worker.postMessage({ lines, query, options });
    return () => {
      clearTimeout(timeout);
      worker.terminate();
    };
  }, [lines, query, options]);
  return found?.query === query && found.lines === lines && found.options === options
    ? found
    : undefined;
}

export function ViewerFind({
  query,
  onQuery,
  options,
  onOptions,
  result,
  index,
  step,
  close,
  timedOut,
  editable,
  onReplace,
  onSelectAll,
}: {
  query: string;
  onQuery: (query: string) => void;
  options: FindOptions;
  onOptions: (options: FindOptions) => void;
  result: FindResult | undefined;
  index: number;
  step: (change: number) => void;
  close: () => void;
  timedOut: boolean;
  editable: boolean;
  onReplace: (replacement: string, all: boolean) => void;
  onSelectAll: () => void;
}) {
  const t = useT();
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const flags = [
    { key: 'matchCase', icon: findIcons.caseSensitive, label: t('files.viewer.matchCase') },
    { key: 'wholeWord', icon: findIcons.wholeWord, label: t('files.viewer.wholeWord') },
    { key: 'regexp', icon: findIcons.regex, label: t('files.viewer.regexp') },
  ] as const;
  const count = result?.matches.length ?? 0;
  const status = !query
    ? ''
    : timedOut
      ? t('files.viewer.searchBudget')
      : result?.invalid
        ? t('files.viewer.invalidRegex')
        : result
          ? count
            ? t(result.truncated ? 'files.viewer.matchesLimited' : 'files.viewer.matches', {
                current: index + 1,
                total: count,
              })
            : t('files.viewer.noMatches')
          : '…';
  return (
    <div className="file-find file-find-bar" role="search" aria-label={t('files.viewer.find')}>
      <div className="file-find-row">
        {editable && (
          <IconButton
            className="file-find-toggle"
            label={t(replaceOpen ? 'md.edit.hideReplace' : 'md.edit.showReplace')}
            aria-expanded={replaceOpen}
            onClick={() => {
              setReplaceOpen((open) => !open);
            }}
          >
            {findIcons.chevron}
          </IconButton>
        )}
        <input
          name="search"
          autoFocus
          aria-label={t('files.viewer.find')}
          placeholder={t('files.viewer.find')}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="file-find-count" role="status">
          {status}
        </span>
        {flags.map((flag) => (
          <IconButton
            key={flag.key}
            label={flag.label}
            aria-pressed={options[flag.key]}
            onClick={() => {
              onOptions({ ...options, [flag.key]: !options[flag.key] });
            }}
          >
            {flag.icon}
          </IconButton>
        ))}
        <IconButton
          label={t('md.edit.previous')}
          disabled={!count}
          onClick={() => {
            step(-1);
          }}
        >
          {findIcons.up}
        </IconButton>
        <div className="file-find-actions">
          <IconButton
            label={t('md.edit.next')}
            disabled={!count}
            onClick={() => {
              step(1);
            }}
          >
            {findIcons.down}
          </IconButton>
          <IconButton label={t('md.edit.all')} disabled={!count} onClick={onSelectAll}>
            {findIcons.all}
          </IconButton>
          <IconButton label={t('md.edit.close')} onClick={close}>
            {findIcons.close}
          </IconButton>
        </div>
      </div>
      {editable && (
        <div
          className={
            replaceOpen
              ? 'file-find-row file-find-replace is-open'
              : 'file-find-row file-find-replace'
          }
        >
          <input
            name="replace"
            aria-label={t('md.edit.replace')}
            placeholder={t('md.edit.replace')}
            value={replacement}
            onChange={(e) => {
              setReplacement(e.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                onReplace(replacement, false);
              }
            }}
          />
          <IconButton
            label={t('md.edit.replace')}
            disabled={!count}
            onClick={() => {
              onReplace(replacement, false);
            }}
          >
            {findIcons.replace}
          </IconButton>
          <IconButton
            label={t('md.edit.replaceAll')}
            disabled={!count}
            onClick={() => {
              onReplace(replacement, true);
            }}
          >
            {findIcons.replaceAll}
          </IconButton>
        </div>
      )}
    </div>
  );
}

export function GoToLine({
  count,
  go,
  closeTool,
}: {
  count: number;
  go: (location: { line: number; column: number }) => void;
  closeTool: () => void;
}) {
  const t = useT(),
    [jump, setJump] = useState(''),
    [badJump, setBadJump] = useState(false);
  return (
    <form
      className="file-find"
      onSubmit={(event) => {
        event.preventDefault();
        const next = parseLocation(jump, count);
        if (next) {
          go(next);
        } else setBadJump(true);
      }}
    >
      <input
        autoFocus
        value={jump}
        placeholder={t('files.viewer.locationHint')}
        aria-label={t('files.viewer.goToLine')}
        aria-invalid={badJump}
        onChange={(e) => {
          setJump(e.target.value);
          setBadJump(false);
        }}
      />
      <small>{t('files.viewer.lineCount', { count })}</small>
      <Button size="small" type="submit">
        {t('files.viewer.go')}
      </Button>
      <IconButton label={t('terminal.findClose')} onClick={closeTool}>
        <CloseIcon />
      </IconButton>
    </form>
  );
}
