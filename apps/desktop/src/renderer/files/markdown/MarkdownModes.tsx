import { SegmentedControl } from '../../app/SegmentedControl.js';
import { useT } from '../../app/app-context.js';
export type FileMode = 'source' | 'edit' | 'split' | 'preview';
const EDITABLE: readonly FileMode[] = ['edit', 'source', 'split', 'preview'];
const READONLY: readonly FileMode[] = ['source', 'split', 'preview'];
// A common optical size and stroke keep the four layouts and neighbouring file actions legible at desktop scale.
const paths = {
  edit: 'M4.5 19.5l1.05-4.45L16.7 3.9a1.8 1.8 0 0 1 2.55 0l.85.85a1.8 1.8 0 0 1 0 2.55L8.95 18.45zM14.8 5.8l3.4 3.4',
  source: 'm7.7 7.9-4.4 4.1 4.4 4.1m8.6-8.2 4.4 4.1-4.4 4.1m-2.75-12-3.1 15.8',
  split:
    'M5.2 4.9h13.6a1.9 1.9 0 0 1 1.9 1.9v10.4a1.9 1.9 0 0 1-1.9 1.9H5.2a1.9 1.9 0 0 1-1.9-1.9V6.8a1.9 1.9 0 0 1 1.9-1.9Zm6.8.2v13.8',
  preview:
    'M12 6.4C9.6 4.9 6.5 4.5 3.4 5.1v13.3c3.2-.6 6.3 0 8.6 1.45 2.3-1.45 5.4-2.05 8.6-1.45V5.1c-3.1-.6-6.2-.2-8.6 1.3Zm0 0v13.25',
  find: 'M17.2 10.45a6.75 6.75 0 1 1-13.5 0 6.75 6.75 0 0 1 13.5 0ZM15.35 15.35l5 5',
  attach:
    'm8.1 12.7 6.9-6.9a3.25 3.25 0 0 1 4.6 4.6l-8.3 8.3a4.65 4.65 0 0 1-6.58-6.58l8.05-8.05m-6.5 10.8a1.6 1.6 0 0 0 2.73 1.13l7.55-7.55',
};
export function MarkdownActionIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
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
      iconOf={(v) => <MarkdownActionIcon name={v} />}
    />
  );
}
