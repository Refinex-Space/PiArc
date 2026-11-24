import type { ReactNode } from 'react';

/** An empty tool pane describes the current state and, if needed, how to populate it. */
export function PanelEmpty({
  title,
  description,
  icon,
  testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div className="tool-empty" data-testid={testId}>
      {icon}
      <p>{title}</p>
      {description !== undefined && <small className="muted">{description}</small>}
    </div>
  );
}
