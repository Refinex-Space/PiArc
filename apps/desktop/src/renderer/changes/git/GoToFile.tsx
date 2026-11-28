// "Go to file" (Mod+P inside the Changes view): a filter field over the scope's changed files,
// ranked by the palettes' fuzzy match on the file name first and the path second. Enter shows
// the file in the diff list, Escape or a click outside closes it.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../app/app-context.js';
import { revealListOption } from '../../app/list-navigation.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { isImeComposing } from '../../composer/ime-guard.js';
import { TreeTypeIcon } from '../../files/tree-row.js';
import { revealBidi } from '../../transcript/reveal.js';
import { fuzzyFilter } from '../../../shared/fuzzy.js';
import { GOTO_LIMIT } from './model.js';
import type { FileChange } from './protocol.js';

export function GoToFile({
  files,
  onPick,
  onClose,
}: {
  readonly files: readonly FileChange[];
  readonly onPick: (path: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const doc = useSurfaceDocument();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const shown = useMemo(
    () =>
      fuzzyFilter(files, query, (f) => [f.path.slice(f.path.lastIndexOf('/') + 1), f.path]).slice(
        0,
        GOTO_LIMIT,
      ),
    [files, query],
  );
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    revealListOption(list.current?.querySelector(`[data-index="${String(active)}"]`) ?? null);
  }, [active]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) === true) return;
      onClose();
    };
    doc.addEventListener('pointerdown', away, true);
    return () => {
      doc.removeEventListener('pointerdown', away, true);
    };
  }, [doc, onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (shown.length === 0 ? 0 : (a + step + shown.length) % shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const file = shown[active];
      if (file !== undefined) onPick(file.path);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  const listId = `${id}-list`;
  return (
    <div className="git-goto" ref={root} data-testid="git-goto-popover">
      <input
        type="text"
        className="git-goto-input"
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[active] === undefined ? undefined : `${id}-${String(active)}`}
        aria-label={t('git.goto.label')}
        placeholder={t('git.goto.placeholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={onKeyDown}
        data-testid="git-goto-input"
      />
      <ul
        className="interactive-list git-goto-list"
        id={listId}
        role="listbox"
        ref={list}
        aria-label={t('git.goto.label')}
      >
        {shown.length === 0 ? (
          <li className="git-note" role="presentation">
            {t('git.goto.none')}
          </li>
        ) : (
          shown.map((file, index) => {
            const slash = file.path.lastIndexOf('/');
            return (
              <li
                key={file.path}
                id={`${id}-${String(index)}`}
                role="option"
                aria-selected={index === active}
                data-index={index}
                className={index === active ? 'git-goto-item is-active' : 'git-goto-item'}
                onPointerMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  onPick(file.path);
                }}
              >
                <TreeTypeIcon name={file.path.slice(slash + 1)} directory={false} open={false} />
                <span className="git-goto-name">{revealBidi(file.path.slice(slash + 1))}</span>
                <span className="git-goto-dir">
                  {revealBidi(slash < 0 ? '' : file.path.slice(0, slash))}
                </span>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
