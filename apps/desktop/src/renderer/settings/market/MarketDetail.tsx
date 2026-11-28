// One market package (ADR-0102): its head (kind tile, name, publisher and version, uninstall and
// the primary action), what to watch out for, its facts and its README, read from the registry
// when it opens (offline: what the catalog cached). Links open through the main process's
// confirmation; the README renders through `MarkdownView` only (raw HTML stays text, remote
// images stay host cards).
import type { MarketDetail as Detail } from '@piarc/protocol';
import { useContext, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { reason } from '../../shell/errors.js';
import { UiContext } from '../../shell/ui.js';
import { SessionTranscript } from '../../store/transcript.js';
import { MarkdownView } from '../../transcript/markdown/MarkdownView.js';
import { parseMarkdown } from '../../transcript/markdown/incremental.js';
import { revealBidi as reveal } from '../../transcript/reveal.js';
import {
  createTranscriptServices,
  TranscriptContext,
  type TranscriptView,
} from '../../transcript/services.js';
import { DetailHead, InfoSection, type InfoItem } from '../catalog.js';
import { hintId, UninstallButton } from '../PluginsSection.js';
import { MarketAction, type MarketRun, type MarketTarget } from './MarketAction.js';
import { entryTile, kindsText } from './market-kinds.js';
import { parseDetail } from './market-data.js';

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
      {truncated && <p className="catalog-note">{t('market.detail.readmeTruncated')}</p>}
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
}: {
  readonly name: string;
  readonly target: MarketTarget;
  readonly busy: boolean;
  readonly run: MarketRun;
  /** Changes when the market changed (installs, kinds): the details are read again. */
  readonly revision: number;
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
  if (entry === undefined) {
    return error === '' ? (
      <p className="catalog-notice is-plain">{t('market.detail.loading')}</p>
    ) : (
      <p className="catalog-notice is-danger" role="alert">
        {error}
      </p>
    );
  }
  const link = (url: string | null | undefined, label: string, testId: string) =>
    url == null ? null : (
      <button
        key={testId}
        type="button"
        className="catalog-link"
        data-testid={testId}
        data-tooltip={url}
        onClick={() => {
          void window.piarc.openExternal(url);
        }}
      >
        {label}
      </button>
    );
  const links = [
    link(detail?.npmUrl, t('market.detail.npm'), 'market-link-npm'),
    link(detail?.repositoryUrl, t('market.detail.repository'), 'market-link-repository'),
    link(detail?.homepageUrl, t('market.detail.homepage'), 'market-link-homepage'),
  ].filter((l) => l !== null);
  const keywords = detail?.keywords ?? [];
  const facts: InfoItem[] = [
    { label: t('market.detail.kinds'), value: kindsText(t, entry) || t('market.kindUnknown') },
    { label: t('catalog.about.version'), value: entry.version },
    { label: t('market.detail.publisher'), value: reveal(entry.publisher) || '—' },
    { label: t('market.detail.downloads'), value: format.number(entry.downloadsMonthly) },
    ...(entry.updated > 0
      ? [{ label: t('catalog.about.updated'), value: format.dateTime(entry.updated) }]
      : []),
    { label: t('market.detail.license'), value: detail?.license ?? '—' },
    {
      label: t('market.detail.dependencies'),
      value: (
        <span
          data-tooltip={detail?.dependencies.length ? detail.dependencies.join(', ') : undefined}
        >
          {t('market.dependencies', { count: detail?.dependencies.length ?? 0 })}
        </span>
      ),
    },
    ...(keywords.length > 0
      ? [
          {
            label: t('market.detail.keywords'),
            value: (
              <span className="catalog-chips">
                {keywords.slice(0, 12).map((k) => (
                  <span key={k} className="catalog-chip">
                    {reveal(k)}
                  </span>
                ))}
              </span>
            ),
          },
        ]
      : []),
    ...(links.length > 0
      ? [{ label: t('market.detail.links'), value: <span className="catalog-links">{links}</span> }]
      : []),
  ];
  const warnings: { text: string; danger: boolean }[] = [];
  if (detail?.problem != null) warnings.push({ text: t('market.detail.offline'), danger: false });
  if (entry.insecure) warnings.push({ text: t('market.insecure'), danger: true });
  if (entry.deprecated) {
    warnings.push({
      text: t('market.warn.deprecated', { message: reveal(detail?.deprecatedMessage ?? '') }),
      danger: true,
    });
  }
  if ((detail?.foreignDependencies.length ?? 0) > 0) {
    warnings.push({
      text: t('market.warn.foreign', { list: detail?.foreignDependencies.join(', ') ?? '' }),
      danger: true,
    });
  }
  if ((detail?.installScripts.length ?? 0) > 0) {
    warnings.push({
      text: t('market.warn.scripts', { list: detail?.installScripts.join(', ') ?? '' }),
      danger: false,
    });
  }
  if (entry.kinds.includes('theme')) warnings.push({ text: t('market.warn.theme'), danger: false });
  return (
    <div className="catalog-detail" data-testid="market-detail" data-name={name}>
      <DetailHead
        kind={entryTile(entry)}
        title={reveal(entry.name)}
        subtitle={[
          reveal(entry.publisher),
          `v${entry.version}`,
          entry.updated > 0
            ? t('market.updatedAgo', { when: format.relative(entry.updated, Date.now()) })
            : '',
        ]
          .filter((part) => part !== '')
          .join(' · ')}
        actions={
          <>
            {entry.installed != null && (
              <UninstallButton
                name={entry.installed.id}
                sure={sure}
                busy={busy || entry.installing}
                onSure={setSure}
                onUninstall={() => {
                  const id = entry.installed?.id ?? '';
                  run(name, t('market.uninstalling', { name }), async () => {
                    await window.piarc.uninstallPackage(id, target.workspace);
                    return t('market.uninstalled', { name });
                  });
                }}
              />
            )}
            <MarketAction entry={entry} target={target} busy={busy} run={run} size="page" />
          </>
        }
      />
      {sure && entry.installed != null && (
        <p
          className="package-uninstall-hint"
          id={hintId(entry.installed.id)}
          data-testid="package-uninstall-hint"
        >
          {t('plugins.uninstallConfirmHint')}
        </p>
      )}
      {entry.description !== '' && (
        <p className="catalog-detail-description">{reveal(entry.description)}</p>
      )}
      {warnings.length > 0 && (
        <ul
          className={`catalog-warnings${warnings.some((w) => w.danger) ? ' is-danger' : ''}`}
          data-testid="market-warnings"
        >
          {warnings.map((w) => (
            <li key={w.text}>{w.text}</li>
          ))}
        </ul>
      )}
      <InfoSection title={t('catalog.section.info')} items={facts} testId="market-facts" />
      <InfoSection title={t('market.detail.readme')} testId="market-readme-section">
        {detail?.readme != null ? (
          <Readme text={detail.readme} truncated={detail.readmeTruncated} />
        ) : (
          <p className="catalog-note">
            {t(
              detail?.readmeTooLarge === true
                ? 'market.detail.readmeTooLarge'
                : 'market.detail.noReadme',
            )}
          </p>
        )}
      </InfoSection>
    </div>
  );
}
