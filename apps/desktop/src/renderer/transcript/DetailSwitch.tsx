// The transcript's view switch (T29): normal, thinking, detailed. A radio group in the
// conversation's title bar; arrow keys move between the options like any radio group.
import { useId } from 'react';

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
  const name = useId();
  return (
    <div
      className="segmented detail-switch"
      role="radiogroup"
      aria-label={t('transcript.view.label')}
      data-testid="detail-switch"
    >
      {TRANSCRIPT_DETAILS.map((detail) => (
        <label
          key={detail}
          className={`segment${detail === value ? ' is-selected' : ''}`}
          title={t(`transcript.view.${detail}Hint`)}
        >
          <input
            type="radio"
            name={name}
            value={detail}
            checked={detail === value}
            data-testid={`detail-${detail}`}
            onChange={() => {
              onChange(detail);
            }}
          />
          {t(`transcript.view.${detail}`)}
        </label>
      ))}
    </div>
  );
}
