// The scope at a page's head (ADR-0101): the project a per-project page shows, as a pill with
// the folder's name; pages that can also show every project put "All" beside it.
import type { ReactNode } from 'react';

import { ChevronDownIcon, FolderIcon, LayersIcon } from '../shell/icons.js';

export function ScopePicker({
  all,
  children,
}: {
  /** The "every project" segment, when the page has one. */
  readonly all?: {
    readonly label: string;
    readonly selected: boolean;
    readonly onSelect: () => void;
    readonly testId?: string;
  };
  /** The project `<select>`. */
  readonly children: ReactNode;
}) {
  return (
    <span className="settings-scope" data-has-all={all !== undefined}>
      {all !== undefined && (
        <button
          type="button"
          className="settings-scope-all"
          aria-pressed={all.selected}
          data-testid={all.testId}
          onClick={all.onSelect}
        >
          <LayersIcon />
          {all.label}
        </button>
      )}
      <span className="settings-scope-project" data-selected={!all?.selected}>
        <FolderIcon />
        {children}
        <ChevronDownIcon />
      </span>
    </span>
  );
}
