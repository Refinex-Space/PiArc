import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon } from '../shell/icons.js';
import type { FileSelection } from './viewer-model.js';

export function FileSelectionBar({
  selection,
  comment,
  setComment,
  attachSelection,
  clear,
}: {
  selection: FileSelection;
  comment: string | undefined;
  setComment: (value: string | undefined) => void;
  attachSelection: (value: FileSelection) => void;
  clear: () => void;
}) {
  const t = useT();
  return (
    <div className="file-selection-bar" aria-label={t('files.viewer.selection')} role="group">
      <small>
        {t(selection.startLine === selection.endLine ? 'files.viewer.line' : 'files.viewer.range', {
          line: selection.startLine,
          start: selection.startLine,
          end: selection.endLine,
        })}
      </small>
      {comment === undefined ? (
        <>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setComment('');
            }}
          >
            {t('files.viewer.comment')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              attachSelection(selection);
            }}
          >
            {t('files.viewer.attachSelection')}
          </Button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) attachSelection({ ...selection, comment: comment.trim() });
          }}
        >
          <input
            autoFocus
            value={comment}
            aria-label={t('files.viewer.comment')}
            placeholder={t('files.viewer.comment')}
            onChange={(e) => {
              setComment(e.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setComment(undefined);
              }
            }}
          />
          <Button size="small" type="submit" disabled={!comment.trim()}>
            {t('files.viewer.attachComment')}
          </Button>
        </form>
      )}
      <IconButton
        label={t('files.viewer.clearSelection')}
        onClick={() => {
          clear();
        }}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}
