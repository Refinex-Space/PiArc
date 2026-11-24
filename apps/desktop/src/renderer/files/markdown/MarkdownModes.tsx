import { SegmentedControl } from '../../app/SegmentedControl.js';
import { useT } from '../../app/app-context.js';
export type FileMode = 'source' | 'edit' | 'split' | 'preview';
const EDITABLE: readonly FileMode[] = ['edit', 'source', 'split', 'preview'];
const READONLY: readonly FileMode[] = ['source', 'split', 'preview'];
const icons = {
  edit: 'M14 5l5 5 M4 20l4-1 13-13-4-4L4 15z',
  source: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-3 18',
  split: 'M3 4h18v16H3z M12 4v16',
  preview: 'M12 6c-3-2-6-2-10-1v14c4-1 7-1 10 1 3-2 6-2 10-1V5c-4-1-7-1-10 1zm0 0v14',
};
export function MarkdownModes({
  mode,
  change,
  editable,
}: {
  mode: FileMode;
  change: (value: FileMode) => void;
  editable: boolean;
}) {
  const t = useT();
  return (
    <SegmentedControl
      options={editable ? EDITABLE : READONLY}
      value={mode}
      onChange={change}
      aria-label={t('files.md.mode')}
      labelOf={(v) => t(`files.md.mode.${v}`)}
      testIdPrefix="md-mode"
      className="markdown-modes"
      iconOf={(v) => (
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={icons[v]} />
        </svg>
      )}
    />
  );
}
