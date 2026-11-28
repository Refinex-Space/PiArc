// The plan panel (T26, ADR-0103; a dock tile): the selected session's plan, rendered. A plan
// waiting for review takes inline comments (select a passage, write the comment); the plan card
// and a reply in the composer send them. Without a pending plan the panel shows the last
// approved one, read-only.
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { PanelEmpty } from '../shell/PanelEmpty.js';
import { CheckIcon, CommentIcon, CopyGlyph, LayoutListIcon } from '../shell/icons.js';
import { useHarness, useSession } from '../store/hooks.js';
import { PlanDocument } from './PlanDocument.js';

const COPIED_MS = 1_500;

function CopyPlan({ plan }: { readonly plan: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <IconButton
      size="xs"
      label={copied ? t('plan.panel.copied') : t('plan.panel.copy')}
      data-testid="plan-copy"
      onClick={() => {
        navigator.clipboard.writeText(plan).then(
          () => {
            setCopied(true);
          },
          (error: unknown) => {
            console.error('[plan] copying failed', error);
          },
        );
      }}
    >
      {copied ? <CheckIcon /> : <CopyGlyph />}
    </IconButton>
  );
}

export function PlanPanel({ sessionId }: { readonly sessionId: string | undefined }) {
  const t = useT();
  const session = useSession(sessionId);
  const harness = useHarness(sessionId);
  const pending = session?.approvals.find((r) => r.kind === 'plan');
  const approved = harness?.plan;
  if (sessionId === undefined || (pending === undefined && approved === undefined)) {
    return (
      <PanelEmpty
        testId="plan-panel-empty"
        icon={<LayoutListIcon />}
        title={t('plan.panel.empty')}
      />
    );
  }
  const plan = pending?.plan ?? approved?.plan ?? '';
  return (
    <div
      className="plan-panel"
      data-testid="plan-panel"
      data-state={pending ? 'pending' : 'approved'}
    >
      <div className="plan-panel-head">
        <span className="plan-state" data-state={pending ? 'pending' : 'approved'}>
          {pending !== undefined || approved === undefined
            ? t('plan.panel.pending')
            : t('plan.panel.approved', { mode: t(`approval.mode.${approved.mode}`) })}
        </span>
        {pending !== undefined ? (
          <span className="plan-panel-hint" data-tooltip={t('plan.panel.hint')}>
            <CommentIcon />
            <span className="plan-panel-hint-text">{t('plan.panel.hint')}</span>
          </span>
        ) : null}
        <CopyPlan plan={plan} />
      </div>
      <PlanDocument
        key={pending?.requestId ?? approved?.entryId}
        sessionId={sessionId}
        plan={plan}
        requestId={pending?.requestId}
      />
    </div>
  );
}
