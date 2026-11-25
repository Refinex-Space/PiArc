// The project trust dialog (architecture section 10.2, FR-WS-01): before the first session in a
// workspace, it lists the project's executable configuration by category and source file and
// asks the user to trust it or continue restricted. When items were added after the user
// trusted the project, it lists only those. The decision is stored in Core.
import { useEffect, useId, useRef, useState } from 'react';

import { isMessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { Dialog } from './Dialog.js';
import { baseName, type TrustMode } from './ui.js';
import { reason } from './errors.js';

interface TrustItem {
  readonly category: string;
  readonly source: string;
  readonly name: string;
}

/** The parts of Core's `TrustView` the dialog shows. */
export interface TrustView {
  readonly version: string;
  readonly applied: boolean;
  readonly decision: 'trusted' | 'denied' | null;
  readonly trusted: boolean;
  readonly items: readonly TrustItem[];
  readonly newItems: readonly TrustItem[];
  readonly unreadable: readonly string[];
}

function items(value: unknown): TrustItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const { category, source, name } = item as Record<string, unknown>;
    return typeof category === 'string' && typeof source === 'string' && typeof name === 'string'
      ? [{ category, source, name }]
      : [];
  });
}

/** Parses Core's JSON; `undefined` when it is not a trust view. */
export function parseTrustView(text: string): TrustView | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const view = value as Record<string, unknown>;
  const decision = view.decision === 'trusted' || view.decision === 'denied' ? view.decision : null;
  const unreadable = Array.isArray(view.unreadable)
    ? view.unreadable.flatMap((u: unknown) =>
        typeof u === 'object' &&
        u !== null &&
        typeof (u as { source?: unknown }).source === 'string'
          ? [(u as { source: string }).source]
          : [],
      )
    : [];
  if (typeof view.version !== 'string') return undefined;
  return {
    version: view.version,
    applied: view.applied === true,
    decision,
    trusted: view.trusted === true,
    items: items(view.items),
    newItems: items(view.newItems),
    unreadable,
  };
}

/** Whether the user has to decide before a session starts in the workspace. */
export function needsDecision(view: TrustView): boolean {
  return view.decision === null || (view.decision === 'trusted' && !view.trusted);
}

const CATEGORY_ORDER = [
  'hook',
  'mcpServer',
  'allowRule',
  'permissionMode',
  'additionalDirectory',
  'plugin',
  'piExtension',
];

export function TrustDialog({
  workspace,
  mode,
  onDone,
}: {
  readonly workspace: string;
  readonly mode: TrustMode;
  /** `undefined`: cancelled; otherwise the decision that was stored. */
  readonly onDone: (decided: boolean | undefined) => void;
}) {
  const t = useT();
  const titleId = useId();
  const [view, setView] = useState<TrustView | 'loading' | { failed: string }>('loading');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const deny = useRef<HTMLButtonElement>(null);
  const loaded = typeof view === 'object' && 'items' in view;
  // Once the items are on screen, the safe choice has the focus.
  useEffect(() => {
    if (loaded) {
      deny.current?.focus();
    }
  }, [loaded]);
  useEffect(() => {
    let active = true;
    window.piarc.projectTrust(workspace).then(
      (text) => {
        if (active) {
          setView(parseTrustView(text) ?? { failed: 'malformed trust view' });
        }
      },
      (error: unknown) => {
        if (active) {
          setView({ failed: reason(error) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [workspace]);
  const name = baseName(workspace);
  const onlyNew =
    typeof view === 'object' && 'items' in view && mode === 'decide' && view.decision === 'trusted';
  const listed =
    typeof view === 'object' && 'items' in view ? (onlyNew ? view.newItems : view.items) : [];
  const decide = (trusted: boolean) => {
    if (!loaded) return;
    setBusy(true);
    window.piarc.decideProjectTrust(workspace, trusted, view.version).then(
      (text) => {
        const updated = parseTrustView(text);
        if (updated?.applied && (!trusted || updated.trusted)) onDone(trusted);
        else {
          setBusy(false);
          setChanged(updated !== undefined);
          setView(updated ?? { failed: 'malformed trust view' });
          deny.current?.focus();
        }
      },
      (error: unknown) => {
        setBusy(false);
        setView({ failed: reason(error) });
      },
    );
  };
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: listed.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
  return (
    <Dialog
      labelledBy={titleId}
      onCancel={() => {
        onDone(undefined);
      }}
      testId="trust-dialog"
      wide
    >
      <h2 id={titleId} className="dialog-title">
        {onlyNew ? t('trust.newTitle', { name }) : t('trust.title', { name })}
      </h2>
      {view === 'loading' && <p className="muted">{t('trust.loading')}</p>}
      {typeof view === 'object' && 'failed' in view && (
        <p className="error-text" role="alert">
          {t('trust.failed', { reason: view.failed })}
        </p>
      )}
      {typeof view === 'object' && 'items' in view && (
        <>
          {changed && <p role="status">{t('trust.changed')}</p>}
          <p>{onlyNew ? t('trust.newIntro') : t('trust.intro')}</p>
          {mode === 'review' && (
            <p className="muted" data-testid="trust-current">
              {t('trust.current', {
                decision: t(
                  view.decision === 'trusted'
                    ? 'trust.decision.trusted'
                    : view.decision === 'denied'
                      ? 'trust.decision.denied'
                      : 'trust.decision.none',
                ),
              })}
            </p>
          )}
          {groups.length === 0 ? (
            <p className="muted">{t('trust.none')}</p>
          ) : (
            <div className="trust-groups" data-testid="trust-items">
              {groups.map((group) => {
                const label = `trust.category.${group.category}`;
                return (
                  <section
                    key={group.category}
                    className="trust-group"
                    data-category={group.category}
                  >
                    <h3>{isMessageId(label) ? t(label) : group.category}</h3>
                    <ul>
                      {group.items.map((item) => (
                        <li key={`${item.source}\u0000${item.name}`} data-testid="trust-item">
                          <code>{item.name}</code>
                          <span className="muted"> · {item.source}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {view.unreadable.length > 0 && (
            <p className="warning-text">
              {t('trust.unreadable', { files: view.unreadable.join(', ') })}
            </p>
          )}
          <p className="muted small">{t('trust.memory')}</p>
          <p className="muted small">{t('trust.restricted')}</p>
        </>
      )}
      <div className="dialog-actions">
        {mode === 'review' && (
          <button
            type="button"
            className="button"
            onClick={() => {
              onDone(undefined);
            }}
          >
            {t('trust.cancel')}
          </button>
        )}
        <button
          type="button"
          className="button"
          disabled={busy || typeof view !== 'object' || 'failed' in view}
          data-testid="trust-deny"
          ref={deny}
          onClick={() => {
            decide(false);
          }}
        >
          {t('trust.dontTrust')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !loaded || view.unreadable.length > 0}
          data-testid="trust-accept"
          onClick={() => {
            decide(true);
          }}
        >
          {onlyNew ? t('trust.confirmNew') : t('trust.trust')}
        </button>
      </div>
    </Dialog>
  );
}
