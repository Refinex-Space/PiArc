// The parts the Skills & plugins page builds its views from (ADR-0102): text tabs with counts,
// a compact search, rows of one shape (a kind tile, a name, one line of description, quiet
// trailing controls), a pager like the audit's, a trail back to the page, an item's head and an
// "About" list of facts. One row shape for skills, packages, extensions, prompts and the market
// keeps the views reading alike; details live on the item's page, not in the list.
import type { ReactNode } from 'react';
import { useId } from 'react';

import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import {
  ChevronRightIcon,
  ExtensionIcon,
  PackageIcon,
  PromptIcon,
  SearchIcon,
  SkillIcon,
  StyleIcon,
} from '../shell/icons.js';

export type CatalogKind = 'skill' | 'extension' | 'package' | 'prompt' | 'style';

const KIND_ICONS = {
  skill: SkillIcon,
  extension: ExtensionIcon,
  package: PackageIcon,
  prompt: PromptIcon,
  style: StyleIcon,
} as const;

/** A square tile with the kind's glyph: what stands in for an icon packages do not have. */
export function KindTile({
  kind,
  size = 'md',
}: {
  readonly kind: CatalogKind;
  readonly size?: 'md' | 'lg';
}) {
  const Icon = KIND_ICONS[kind];
  return (
    <span className={`catalog-tile is-${size}`} data-kind={kind} aria-hidden="true">
      <Icon />
    </span>
  );
}

export interface CatalogTab<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number | undefined;
}

/** Text tabs with counts; native radios carry the arrow keys and the selection. */
export function CatalogTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  testIdPrefix,
}: {
  readonly label: string;
  readonly tabs: readonly CatalogTab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly testIdPrefix: string;
}) {
  const { format } = useApp();
  const name = useId();
  return (
    <div className="catalog-tabs" role="radiogroup" aria-label={label}>
      {tabs.map((tab) => (
        <label key={tab.id} className="catalog-tab" data-selected={tab.id === value || undefined}>
          <input
            type="radio"
            name={name}
            value={tab.id}
            checked={tab.id === value}
            data-testid={`${testIdPrefix}-${tab.id}`}
            onChange={() => {
              onChange(tab.id);
            }}
          />
          <span>{tab.label}</span>
          {tab.count !== undefined && (
            <span className="catalog-tab-count">{format.number(tab.count)}</span>
          )}
        </label>
      ))}
    </div>
  );
}

/** The row under a view's heading: tabs on the leading edge, filters on the trailing one. */
export function CatalogToolbar({ children }: { readonly children: ReactNode }) {
  return <div className="catalog-toolbar">{children}</div>;
}

export function CatalogSearch({
  value,
  label,
  testId,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly testId: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="catalog-search" htmlFor={id}>
      <SearchIcon />
      <input
        id={id}
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        data-testid={testId}
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
      />
    </label>
  );
}

export function CatalogList({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <ul className="catalog-list" data-testid={testId}>
      {children}
    </ul>
  );
}

/**
 * One record: the tile, the name (with a quiet note after it) and one line of description open
 * the record's page; `trailing` holds the record's own controls (a switch, an install button).
 */
export function CatalogRow({
  kind,
  title,
  note,
  description,
  trailing,
  openLabel,
  onOpen,
  testId,
  data,
}: {
  readonly kind: CatalogKind;
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly description?: ReactNode;
  readonly trailing?: ReactNode;
  /** The accessible name of the open button. */
  readonly openLabel: string;
  readonly onOpen?: (() => void) | undefined;
  readonly testId: string;
  /** `data-*` attributes tests and styles find the row by. */
  readonly data?: Readonly<Record<string, string | undefined>>;
}) {
  const attributes = Object.fromEntries(
    Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]),
  );
  return (
    <li className="catalog-row" data-testid={testId} {...attributes}>
      <KindTile kind={kind} />
      <div className="catalog-row-text">
        <div className="catalog-row-title">
          {onOpen === undefined ? (
            <span className="catalog-row-name">{title}</span>
          ) : (
            <button
              type="button"
              className="catalog-row-name catalog-row-open"
              aria-label={openLabel}
              data-testid={`${testId}-open`}
              onClick={onOpen}
            >
              {title}
            </button>
          )}
          {note !== undefined && note !== null && note !== '' && (
            <span className="catalog-row-note">{note}</span>
          )}
        </div>
        {description !== undefined && description !== '' && (
          <p className="catalog-row-description">{description}</p>
        )}
      </div>
      <div className="catalog-row-trailing">
        {trailing}
        {onOpen !== undefined && (
          <span className="catalog-row-chevron" aria-hidden="true">
            <ChevronRightIcon />
          </span>
        )}
      </div>
    </li>
  );
}

/** Nothing to list: one quiet sentence and, when it helps, one action. */
export function CatalogEmpty({
  children,
  action,
  testId,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div className="catalog-empty" data-testid={testId}>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** "1–20 of 5,225" with the previous and next pages, like the audit's pager. */
export function CatalogPager({
  page,
  size,
  total,
  onPage,
  testId,
}: {
  readonly page: number;
  readonly size: number;
  readonly total: number;
  readonly onPage: (page: number) => void;
  readonly testId: string;
}) {
  const { t } = useApp();
  if (total <= size) return null;
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <div className="settings-pager catalog-pager" data-testid={testId}>
      <span className="settings-pager-range">
        {t('permissions.audit.range', { from, to, total })}
      </span>
      <Button
        size="small"
        variant="ghost"
        disabled={page === 0}
        data-testid={`${testId}-previous`}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        {t('permissions.audit.previous')}
      </Button>
      <Button
        size="small"
        variant="ghost"
        disabled={to >= total}
        data-testid={`${testId}-next`}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        {t('permissions.audit.next')}
      </Button>
    </div>
  );
}

export interface Crumb {
  readonly label: string;
  /** Absent: the current place. */
  readonly onClick?: () => void;
  readonly testId?: string;
}

/** The trail back to the page and the catalog (the last crumb is where the user is). */
export function Crumbs({
  items,
  title,
  description,
}: {
  readonly items: readonly Crumb[];
  /** A sub-page's title under the trail (the market); absent on an item's page. */
  readonly title?: string;
  readonly description?: ReactNode;
}) {
  const { t } = useApp();
  return (
    <>
      <nav className="catalog-crumbs" aria-label={t('catalog.trail')}>
        {items.map((item, index) => (
          <span key={`${item.label}-${String(index)}`} className="catalog-crumb">
            {index > 0 && <ChevronRightIcon />}
            {item.onClick === undefined ? (
              <span aria-current="page">{item.label}</span>
            ) : (
              <button type="button" data-testid={item.testId} onClick={item.onClick}>
                {item.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      {title !== undefined && <h2 className="settings-title">{title}</h2>}
      {description !== undefined && <p>{description}</p>}
    </>
  );
}

/** An item's head: its tile, name, one line about it, and its actions on the trailing edge. */
export function DetailHead({
  kind,
  title,
  subtitle,
  actions,
}: {
  readonly kind: CatalogKind;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="catalog-detail-head">
      <KindTile kind={kind} size="lg" />
      <div className="catalog-detail-title">
        <h3>{title}</h3>
        {subtitle !== undefined && subtitle !== '' && <p>{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="catalog-detail-actions">{actions}</div>}
    </header>
  );
}

export interface InfoItem {
  readonly label: string;
  readonly value: ReactNode;
  readonly testId?: string;
}

/** A section of facts: a short label on the leading column, its value beside it. */
export function InfoSection({
  title,
  items,
  testId,
  children,
}: {
  readonly title: string;
  readonly items?: readonly InfoItem[];
  readonly testId?: string;
  readonly children?: ReactNode;
}) {
  return (
    <section className="catalog-section" data-testid={testId}>
      <h4 className="catalog-section-title">{title}</h4>
      {items !== undefined && items.length > 0 && (
        <dl className="catalog-info">
          {items.map((item) => (
            <div key={item.label} className="catalog-info-row" data-testid={item.testId}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}
