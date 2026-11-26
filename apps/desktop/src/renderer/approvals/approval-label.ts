// The name of an approval card for screen readers (T43, architecture section 8.7): its kind and
// what it is about, "Run command? env echo hello". Focus moves to the card when it appears
// (`use-approval-focus.ts`), so this is what is announced.
import type { ApprovalRequest } from '@piarc/protocol';

import type { MessageId } from '../../shared/i18n/index.js';

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

/** The first line of a long object, so the name stays short. */
function short(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function approvalLabel(request: ApprovalRequest, t: Translate): string {
  // The sandbox's network-domain card (T39) has no tool call: it asks about a host.
  if (request.tool === 'SandboxNetwork' && request.domain != null) {
    return t('a11y.approval', { kind: t('approval.network'), target: request.domain });
  }
  // A site card (ADR-0089) asks about the address an agent's page wants to open.
  if (request.tool === 'BrowserSite' && request.site != null) {
    return t('a11y.approval', { kind: t('approval.site'), target: request.site.url });
  }
  const target =
    request.kind === 'command'
      ? (request.command ?? request.tool)
      : request.kind === 'question'
        ? (request.questions?.[0]?.question ?? '')
        : request.kind === 'plan'
          ? (request.plan ?? '')
          : (request.path ?? request.directory ?? request.tool);
  return t('a11y.approval', { kind: t(`approval.kind.${request.kind}`), target: short(target) });
}
