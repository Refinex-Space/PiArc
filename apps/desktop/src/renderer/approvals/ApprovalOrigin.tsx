// Where an approval card comes from (T31): a subagent's card shows in its main session and
// names the subagent (its task description and type).
import type { ApprovalRequest } from '@piarc/protocol';

import { useT } from '../app/app-context.js';

export function ApprovalOrigin({ request }: { readonly request: ApprovalRequest }) {
  const t = useT();
  const origin = request.subagent ?? undefined;
  if (origin === undefined) return null;
  return (
    <div className="approval-origin muted" data-testid="approval-origin">
      {t('approval.fromSubagent', {
        name: origin.description ?? origin.agentType,
        type: origin.agentType,
      })}
    </div>
  );
}
