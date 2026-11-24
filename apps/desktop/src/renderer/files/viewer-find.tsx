import { useState, useEffect } from 'react';
import { Button } from '../app/Button.js';
import { parseLocation } from './viewer-model.js';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../shell/icons.js';
import { NONE_FOUND, type FindOptions, type FindResult } from './viewer-model.js';

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
}) {
  const t = useT();
  const flags = [
    { key: 'matchCase', glyph: 'Aa', label: t('files.viewer.matchCase') },
    { key: 'wholeWord', glyph: 'ab', label: t('files.viewer.wholeWord') },
    { key: 'regexp', glyph: '.*', label: t('files.viewer.regexp') },
  ] as const;
  const count = result?.matches.length ?? 0;
  return (
    <div className="file-find" role="search" aria-label={t('files.viewer.find')}>
      <input
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
      <div className="file-find-options">
        {flags.map((flag) => (
          <IconButton
            key={flag.key}
            label={flag.label}
            aria-pressed={options[flag.key]}
            onClick={() => {
              onOptions({ ...options, [flag.key]: !options[flag.key] });
            }}
          >
            {flag.glyph}
          </IconButton>
        ))}
      </div>
      <small role="status">
        {!query
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
                : '…'}
      </small>
      <IconButton
        label={t('terminal.findPrevious')}
        disabled={!count}
        onClick={() => {
          step(-1);
        }}
      >
        <ChevronLeftIcon />
      </IconButton>
      <IconButton
        label={t('terminal.findNext')}
        disabled={!count}
        onClick={() => {
          step(1);
        }}
      >
        <ChevronRightIcon />
      </IconButton>
      <IconButton label={t('terminal.findClose')} onClick={close}>
        <CloseIcon />
      </IconButton>
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
