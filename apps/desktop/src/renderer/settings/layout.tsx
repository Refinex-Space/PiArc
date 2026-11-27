// The settings page system (ADR-0101, docs/engineering/visual-design.md): a page is sections of
// rows; a section has a title over a hairline, a row has a name and at most one line of
// description on the left and its control on the right. Records (connections, servers, rules)
// are rows of a list, not cards.
import type { ReactNode } from 'react';

import { InfoGlyph } from '../shell/icons.js';

export function SettingsSection({
  title,
  aside,
  children,
  testId,
  id,
}: {
  readonly title: ReactNode;
  /** Actions at the head's trailing edge (an add button, a count). */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly id?: string;
}) {
  return (
    <section className="settings-block" data-testid={testId} id={id}>
      <header className="settings-block-head">
        <h3>{title}</h3>
        {aside !== undefined && aside !== null && (
          <div className="settings-block-aside">{aside}</div>
        )}
      </header>
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  testId,
  labelId,
  htmlFor,
  badge,
  descriptionId,
  descriptionTestId,
  wide = false,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** The control(s), aligned to the row's trailing edge. */
  readonly children?: ReactNode;
  readonly testId?: string;
  /** Id of the name, for `aria-labelledby` on a control that is not a labellable element. */
  readonly labelId?: string;
  /** Id of the control the name labels. */
  readonly htmlFor?: string;
  /** A mark after the name (managed, read-only). */
  readonly badge?: ReactNode;
  /** Id of the description, for `aria-describedby`. */
  readonly descriptionId?: string;
  readonly descriptionTestId?: string;
  /** The control takes its own line under the name (a list, an editor). */
  readonly wide?: boolean;
}) {
  const name = htmlFor ? (
    <label htmlFor={htmlFor} id={labelId} className="settings-row-name">
      {label}
      {badge}
    </label>
  ) : (
    <span id={labelId} className="settings-row-name">
      {label}
      {badge}
    </span>
  );
  return (
    <div className={`settings-row${wide ? ' is-wide' : ''}`} data-testid={testId}>
      <div className="settings-row-copy">
        {name}
        {description !== undefined && description !== null && description !== '' && (
          <p
            className="settings-row-description"
            id={descriptionId}
            data-testid={descriptionTestId}
          >
            {description}
          </p>
        )}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** A record in a list: a leading mark, a name with one line of detail, trailing actions. */
export function SettingsItem({
  lead,
  name,
  detail,
  children,
  testId,
}: {
  readonly lead?: ReactNode;
  readonly name: ReactNode;
  readonly detail?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div className="settings-item" data-testid={testId}>
      {lead}
      <div className="settings-item-body">
        <div className="settings-item-name">{name}</div>
        {detail !== undefined && detail !== null && (
          <div className="settings-item-detail">{detail}</div>
        )}
      </div>
      {children !== undefined && <div className="settings-item-actions">{children}</div>}
    </div>
  );
}

/** A longer explanation kept off the page: an info mark whose tooltip holds the text. */
export function SettingsInfo({
  text,
  testId,
}: {
  readonly text: string;
  readonly testId?: string;
}) {
  return (
    <span
      className="settings-info"
      role="img"
      tabIndex={0}
      aria-label={text}
      data-tooltip={text}
      data-testid={testId}
    >
      <InfoGlyph size={12} />
    </span>
  );
}
