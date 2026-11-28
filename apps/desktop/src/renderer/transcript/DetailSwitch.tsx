// The transcript's view switch (T29): normal, thinking, detailed. A radio group in the
// conversation's title bar; arrow keys move between the options like any radio group.
import { SegmentedControl } from '../app/SegmentedControl.js';

import { useT } from '../app/app-context.js';
import { TRANSCRIPT_DETAILS, type TranscriptDetail } from './detail.js';

export function DetailSwitch({
  value,
  onChange,
}: {
  readonly value: TranscriptDetail;
  readonly onChange: (detail: TranscriptDetail) => void;
}) {
  const t = useT();
  return (
    <SegmentedControl
      options={TRANSCRIPT_DETAILS}
      value={value}
      onChange={onChange}
      labelOf={(detail) => t(`transcript.view.${detail}`)}
      hintOf={(detail) => t(`transcript.view.${detail}Hint`)}
      aria-label={t('transcript.view.label')}
      testId="detail-switch"
      testIdPrefix="detail"
      className="detail-switch"
    />
  );
}
