// One market package (ADR-0102): what it is, what it brings, what to watch out for, and its
// README, read from the registry when it opens (offline: what the catalog cached). Links open
// through the main process's confirmation; the README renders through `MarkdownView` only (raw
// HTML stays text, remote images stay host cards).
import type { MarketDetail as Detail, MarketKind } from '@piarc/protocol';
import { useContext, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { ChevronLeftIcon } from '../../shell/icons.js';
import { reason } from '../../shell/errors.js';
import { MarkdownView } from '../../transcript/markdown/MarkdownView.js';
import {
  createTranscriptServices,
  TranscriptContext,
  type TranscriptView,
} from '../../transcript/services.js';
import { UiContext } from '../../shell/ui.js';
import { SessionTranscript } from '../../store/transcript.js';
import { parseMarkdown } from '../../transcript/markdown/incremental.js';
import { revealBidi as reveal } from '../../transcript/reveal.js';
import { SettingsRow, SettingsSection } from '../layout.js';
import { hintId, UninstallButton } from '../PluginsSection.js';
import { MarketAction, type MarketRun, type MarketTarget } from './MarketAction.js';
import { parseDetail } from './market-data.js';

const KIND_ORDER: readonly MarketKind[] = ['extension', 'skill', 'prompt', 'theme'];

export function KindBadges({ kinds }: { readonly kinds: readonly MarketKind[] }) {
  const { t } = useApp();
  if (kinds.length === 0) {
    return <span className="market-kind is-unknown">{t('market.kindUnknown')}</span>;
  }
  return (
    <>
      {KIND_ORDER.filter((k) => kinds.includes(k)).map((k) => (
        <span key={k} className={`market-kind is-${k}`} data-kind={k}>
          {t(`market.kind.${k}`)}
        </span>
      ))}
    </>
  );
}

function Readme({ text, truncated }: { readonly text: string; readonly truncated: boolean }) {
  const { t } = useApp();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  // Code blocks highlight through the transcript services: the workbench's when settings show
  // in it, otherwise this README's own. Nothing here is a session: no file links, no actions.
  const shared = useContext(UiContext)?.transcriptServices;
  const view = useMemo<TranscriptView>(
    () => ({
      services: shared ?? createTranscriptServices(null),
      transcript: new SessionTranscript(),
      actions: { retry: () => undefined, resend: () => undefined },
    }),
    [shared],
  );
  const [open, setOpen] = useState(false);
  const long = text.length > 4000;
  return (
    <div className="market-readme" data-open={open || !long} data-testid="market-readme">
      <div className="market-readme-body">
        <TranscriptContext.Provider value={view}>
          <MarkdownView blocks={blocks} />
        </TranscriptContext.Provider>
      </div>
      {truncated && <p className="market-note">{t('market.detail.readmeTruncated')}</p>}
      {long && (
        <Button
          variant="ghost"
          size="small"
          className="market-readme-toggle"
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {t(open ? 'market.detail.collapse' : 'market.detail.expand')}
        </Button>
      )}
    </div>
  );
}

export function MarketDetail({
  name,
  target,
  busy,
  run,
  revision,
  onBack,
}: {
  readonly name: string;
  readonly target: MarketTarget;
  readonly busy: boolean;
  readonly run: MarketRun;
  /** Changes when the market changed (installs, kinds): the details are read again. */
  readonly revision: number;
  readonly onBack: () => void;
}) {
  const { t, format } = useApp();
  const [detail, setDetail] = useState<Detail | undefined>(undefined);
  const [error, setError] = useState('');
  const [sure, setSure] = useState(false);
  useEffect(() => {
    let live = true;
    window.piarc
      .marketDetail(name, target.workspace)
      .then((text) => {
        if (live) {
          setDetail(parseDetail(text));
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (live) setError(reason(e));
      });
    return () => {
      live = false;
    };
  }, [name, target.workspace, revision]);
  const entry = detail?.entry;
  const link = (url: string | null | undefined, label: string, testId: string) =>
    url == null ? null : (
      <Button
        variant="ghost"
        size="small"
        data-testid={testId}
        data-tooltip={url}
        onClick={() => {
          void window.piarc.openExternal(url);
        }}
      >
        {label}
      </Button>
    );
  return (
    <div className="market-detail" data-testid="market-detail" data-name={name}>
      <button type="button" className="market-back" data-testid="market-back" onClick={onBack}>
        <ChevronLeftIcon />
        {t('market.back')}
      </button>
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {entry === undefined ? (
        error === '' && <p className="market-note">{t('market.detail.loading')}</p>
      ) : (
        <>
          <header className="market-detail-head">
            <div className="market-detail-title">
              <h2>{reveal(entry.name)}</h2>
              <p>{reveal(entry.description)}</p>
              <p className="market-meta">
                {[
                  `v${entry.version}`,
                  reveal(entry.publisher),
                  entry.updated > 0
                    ? t('market.updatedAgo', { when: format.relative(entry.updated, Date.now()) })
                    : null,
                ]
                  .filter((part) => part !== null && part !== '')
                  .join(' · ')}
              </p>
            </div>
            <span className="market-detail-actions">
              {entry.installed != null && (
                <UninstallButton
                  name={entry.installed.id}
                  sure={sure}
                  busy={busy || entry.installing}
                  onSure={setSure}
                  onUninstall={() => {
                    const id = entry.installed?.id ?? '';
                    run(t('market.uninstalling', { name }), async () => {
                      await window.piarc.uninstallPackage(id, target.workspace);
                      return t('market.uninstalled', { name });
                    });
                  }}
                />
              )}
              <MarketAction entry={entry} target={target} busy={busy} run={run} size="regular" />
            </span>
          </header>
          {sure && entry.installed != null && (
            <p
              className="package-uninstall-hint"
              id={hintId(entry.installed.id)}
              data-testid="package-uninstall-hint"
            >
              {t('plugins.uninstallConfirmHint')}
            </p>
          )}
          <ul className="market-warnings" data-testid="market-warnings">
            {detail?.problem != null && <li>{t('market.detail.offline')}</li>}
            {entry.insecure && <li className="is-danger">{t('market.insecure')}</li>}
            {entry.deprecated && (
              <li className="is-danger">
                {t('market.warn.deprecated', {
                  message: reveal(detail?.deprecatedMessage ?? ''),
                })}
              </li>
            )}
            {(detail?.foreignDependencies.length ?? 0) > 0 && (
              <li className="is-danger">
                {t('market.warn.foreign', { list: detail?.foreignDependencies.join(', ') ?? '' })}
              </li>
            )}
            {(detail?.installScripts.length ?? 0) > 0 && (
              <li>{t('market.warn.scripts', { list: detail?.installScripts.join(', ') ?? '' })}</li>
            )}
            {entry.kinds.includes('theme') && <li>{t('market.warn.theme')}</li>}
          </ul>
          <SettingsSection title={t('market.detail.about')} testId="market-facts">
            <SettingsRow label={t('market.detail.kinds')}>
              <span className="market-kinds">
                <KindBadges kinds={entry.kinds} />
              </span>
            </SettingsRow>
            <SettingsRow label={t('market.detail.downloads')}>
              <span className="market-fact">{format.number(entry.downloadsMonthly)}</span>
            </SettingsRow>
            {detail?.license != null && (
              <SettingsRow label={t('market.detail.license')}>
                <span className="market-fact">{detail.license}</span>
              </SettingsRow>
            )}
            <SettingsRow label={t('market.detail.dependencies')}>
              <span
                className="market-fact"
                data-tooltip={
                  detail?.dependencies.length ? detail.dependencies.join(', ') : undefined
                }
              >
                {t('market.dependencies', { count: detail?.dependencies.length ?? 0 })}
              </span>
            </SettingsRow>
            <SettingsRow label={t('market.detail.links')}>
              <span className="market-links">
                {link(detail?.npmUrl, t('market.detail.npm'), 'market-link-npm')}
                {link(
                  detail?.repositoryUrl,
                  t('market.detail.repository'),
                  'market-link-repository',
                )}
                {link(detail?.homepageUrl, t('market.detail.homepage'), 'market-link-homepage')}
              </span>
            </SettingsRow>
          </SettingsSection>
          <SettingsSection title={t('market.detail.readme')} testId="market-readme-section">
            {detail?.readme != null ? (
              <Readme text={detail.readme} truncated={detail.readmeTruncated} />
            ) : (
              <p className="market-note">
                {t(
                  detail?.readmeTooLarge === true
                    ? 'market.detail.readmeTooLarge'
                    : 'market.detail.noReadme',
                )}
              </p>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
