// The About page (ADR-0111, design addendum `about-and-updates.md`): what PiArc this is, the
// update flow (check, download, restart to install, with the release notes) and the versions
// of the parts it is built from. The menu's "About PiArc" and "Check for Updates…" open it.
// Core does the network and the verification; the page only asks and shows.
import type { UpdateRelease, UpdateStatus } from '@piarc/protocol';
import { useContext, useEffect, useId, useMemo, useState } from 'react';

import type { AboutInfo, UpdateInstallOutcome } from '../../shared/ipc.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { reason } from '../shell/errors.js';
import { CheckGlyph, CopyGlyph, ExternalGlyph } from '../shell/icons.js';
import { UiContext } from '../shell/ui.js';
import { SessionTranscript } from '../store/transcript.js';
import { MarkdownView } from '../transcript/markdown/MarkdownView.js';
import { parseMarkdown } from '../transcript/markdown/incremental.js';
import {
  createTranscriptServices,
  TranscriptContext,
  type TranscriptView,
} from '../transcript/services.js';
import { takeUpdateStatus, useUpdateStatus } from '../updates/update-store.js';
import { notesFor, percentOf, problemText } from '../updates/update-status.js';
import { SettingsItem, SettingsRow, SettingsSection } from './layout.js';
import { ManagedBadge, useIsManaged } from './managed.js';

const REPOSITORY = 'https://github.com/Refinex-Space/PiArc';
const LINKS: readonly { readonly id: string; readonly label: MessageId; readonly url: string }[] = [
  { id: 'releases', label: 'about.link.releases', url: `${REPOSITORY}/releases` },
  { id: 'source', label: 'about.link.source', url: REPOSITORY },
  { id: 'issues', label: 'about.link.issues', url: `${REPOSITORY}/issues/new/choose` },
  { id: 'license', label: 'about.link.license', url: `${REPOSITORY}/blob/main/LICENSE` },
];

const MANUAL: Record<Extract<UpdateInstallOutcome, { kind: 'manual' }>['reason'], MessageId> = {
  notBundle: 'about.manual.unsupported',
  translocated: 'about.manual.translocated',
  notWritable: 'about.manual.notWritable',
  notInstalled: 'about.manual.notInstalled',
  unsupported: 'about.manual.unsupported',
};

/** The Pi mark on the app icon's rounded square (design/brand/icon.svg, in tokens). */
function AppMark() {
  return (
    <svg className="about-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <rect className="about-mark-tile" width="1024" height="1024" rx="224" />
      <g className="about-mark-glyph" transform="scale(1.28)" fillRule="evenodd">
        <path d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" />
        <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
      </g>
    </svg>
  );
}

/** "186 MB" in the app's language. */
function useSize(): (bytes: number) => string {
  const { format } = useApp();
  return (bytes) => {
    const [unit, value] =
      bytes >= 1_000_000_000
        ? (['gigabyte', bytes / 1e9] as const)
        : bytes >= 1_000_000
          ? (['megabyte', bytes / 1e6] as const)
          : (['kilobyte', Math.max(bytes / 1e3, 0.1)] as const);
    return format.number(value, { style: 'unit', unit, maximumFractionDigits: 1 });
  };
}

function ReleaseNotes({ release }: { readonly release: UpdateRelease }) {
  const { t, locale } = useApp();
  const text = notesFor(release, locale);
  const blocks = useMemo(() => parseMarkdown(text), [text]);
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
  const long = text.length > 1200;
  if (text === '') return null;
  return (
    <div className="about-notes" data-open={open || !long} data-testid="about-notes">
      <div className="about-notes-head">
        <span className="about-notes-title">{t('about.notes', { version: release.version })}</span>
        {release.pageUrl !== '' && (
          <Button
            variant="ghost"
            size="small"
            data-testid="about-notes-page"
            onClick={() => {
              void window.piarc.openExternal(release.pageUrl);
            }}
          >
            {t('about.notes.page')}
          </Button>
        )}
      </div>
      <div className="about-notes-body">
        <TranscriptContext.Provider value={view}>
          <MarkdownView blocks={blocks} />
        </TranscriptContext.Provider>
      </div>
      {long && (
        <Button
          variant="ghost"
          size="small"
          className="about-notes-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {t(open ? 'about.notes.collapse' : 'about.notes.expand')}
        </Button>
      )}
    </div>
  );
}

type Busy = 'check' | 'download' | 'cancel' | 'install';

/** The status line, its one line of detail and the action that fits the state. */
function UpdateRow({
  status,
  busy,
  run,
}: {
  readonly status: UpdateStatus | undefined;
  readonly busy: Busy | undefined;
  readonly run: (what: Busy, action: () => Promise<unknown>) => void;
}) {
  const { t, format } = useApp();
  const size = useSize();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const release = status?.release ?? undefined;
  const checked =
    typeof status?.checkedAt === 'number'
      ? t('about.checked', { when: format.relative(status.checkedAt, now) })
      : undefined;
  const check = (
    <Button
      data-testid="about-check"
      loading={busy === 'check' || status?.state === 'checking'}
      onClick={() => {
        run('check', () => window.piarc.checkForUpdates());
      }}
    >
      {t('about.check')}
    </Button>
  );
  const securityBadge = release?.security === true && (
    <span className="settings-badge about-badge is-security" data-testid="about-security">
      {t('about.security')}
    </span>
  );
  if (status === undefined) {
    return <SettingsRow testId="about-update" label={t('about.status.loading')} />;
  }
  if (status.unavailable != null) {
    return (
      <SettingsRow
        testId="about-update"
        label={t('about.status.unavailable')}
        description={t(
          status.unavailable === 'noTrustedKey'
            ? 'about.unavailable.noTrustedKey'
            : 'about.unavailable.platform',
        )}
      />
    );
  }
  switch (status.state) {
    case 'checking':
      return (
        <SettingsRow testId="about-update" label={t('about.status.checking')}>
          {check}
        </SettingsRow>
      );
    case 'available':
      return (
        <SettingsRow
          testId="about-update"
          label={t('about.status.available', { version: release?.version ?? '' })}
          badge={securityBadge}
          description={
            release === undefined
              ? undefined
              : t('about.release.detail', { date: release.date, size: size(release.size) })
          }
        >
          <Button
            variant="primary"
            data-testid="about-download"
            loading={busy === 'download'}
            onClick={() => {
              run('download', () => window.piarc.downloadUpdate());
            }}
          >
            {t('about.download')}
          </Button>
        </SettingsRow>
      );
    case 'downloading': {
      const percent = percentOf(status);
      const total = status.progress?.total ?? release?.size ?? 0;
      const received = status.progress?.received ?? 0;
      return (
        <SettingsRow
          testId="about-update"
          label={t('about.status.downloading', { version: release?.version ?? '' })}
          badge={securityBadge}
          description={
            <span className="about-progress-line">
              <span
                className="about-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t('about.progress.label')}
                data-testid="about-progress"
              >
                <span className="about-progress-fill" style={{ width: `${String(percent)}%` }} />
              </span>
              <span className="about-progress-text">
                {t('about.progress', {
                  percent: format.number(percent),
                  received: size(received),
                  total: size(total),
                })}
              </span>
            </span>
          }
        >
          <Button
            variant="ghost"
            data-testid="about-cancel"
            loading={busy === 'cancel'}
            onClick={() => {
              run('cancel', () => window.piarc.cancelUpdateDownload());
            }}
          >
            {t('dialog.cancel')}
          </Button>
        </SettingsRow>
      );
    }
    case 'ready':
      return (
        <SettingsRow
          testId="about-update"
          label={t('about.status.ready', { version: release?.version ?? '' })}
          badge={securityBadge}
          description={t('about.ready.detail')}
        >
          <Button
            variant="primary"
            data-testid="about-install"
            loading={busy === 'install'}
            onClick={() => {
              run('install', () => window.piarc.installUpdate());
            }}
          >
            {t('about.install')}
          </Button>
        </SettingsRow>
      );
    case 'failed':
      return (
        <SettingsRow
          testId="about-update"
          label={t(
            release === undefined ? 'about.status.checkFailed' : 'about.status.downloadFailed',
          )}
          description={
            <span
              className="about-problem"
              data-testid="about-problem"
              data-tooltip={status.problem?.message}
            >
              {t(problemText(status.problem))}
            </span>
          }
        >
          {release === undefined ? (
            check
          ) : (
            <Button
              data-testid="about-retry"
              loading={busy === 'download'}
              onClick={() => {
                run('download', () => window.piarc.downloadUpdate());
              }}
            >
              {t('about.retry')}
            </Button>
          )}
        </SettingsRow>
      );
    case 'upToDate':
      return (
        <SettingsRow testId="about-update" label={t('about.status.upToDate')} description={checked}>
          {check}
        </SettingsRow>
      );
    case 'idle':
      return (
        <SettingsRow testId="about-update" label={t('about.status.idle')}>
          {check}
        </SettingsRow>
      );
  }
}

function versionsText(info: AboutInfo, t: (id: MessageId) => string): string {
  return [
    `PiArc ${info.app}${info.release ? '' : ' (development)'}`,
    `Electron ${info.electron}`,
    `Chromium ${info.chromium}`,
    `Node.js ${info.node}`,
    `Pi ${info.pi}`,
    `AHP ${info.protocol}`,
    `libghostty-vt ${info.ghostty}`,
    `${t(info.platform === 'darwin' ? 'about.os.macos' : 'about.os.windows')} ${info.osVersion} (${info.arch})`,
  ].join('\n');
}

export function AboutPage() {
  const { t, preferences } = useApp();
  const status = useUpdateStatus();
  const [info, setInfo] = useState<AboutInfo>();
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState<MessageId>();
  const [copied, setCopied] = useState(false);
  const autoCheckId = useId();
  const autoCheckHint = useId();
  const managedAutoCheck = useIsManaged('/updates/autoCheck');
  useEffect(() => {
    window.piarc.aboutInfo().then(setInfo, (failure: unknown) => {
      setError(reason(failure));
    });
    window.piarc.updateStatus().then(takeUpdateStatus, () => undefined);
  }, []);
  const run = (what: Busy, action: () => Promise<unknown>): void => {
    setBusy(what);
    setError(undefined);
    setManual(undefined);
    action()
      .then((answer) => {
        if (typeof answer === 'string') takeUpdateStatus(answer);
        else if (
          typeof answer === 'object' &&
          answer !== null &&
          'kind' in answer &&
          answer.kind === 'manual' &&
          'reason' in answer &&
          typeof answer.reason === 'string' &&
          answer.reason in MANUAL
        ) {
          setManual(MANUAL[answer.reason as keyof typeof MANUAL]);
        }
      })
      .catch((failure: unknown) => {
        setError(reason(failure));
      })
      .finally(() => {
        setBusy(undefined);
      });
  };
  const release = status?.release ?? undefined;
  const showNotes =
    release !== undefined &&
    (status?.state === 'available' ||
      status?.state === 'downloading' ||
      status?.state === 'ready' ||
      status?.state === 'failed');
  const copy = (): void => {
    if (info === undefined) return;
    void navigator.clipboard.writeText(versionsText(info, t)).then(() => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    });
  };
  const os =
    info === undefined
      ? ''
      : `${t(info.platform === 'darwin' ? 'about.os.macos' : 'about.os.windows')} ${info.osVersion}`;
  return (
    <div className="about-page" data-testid="about-page">
      <header className="about-hero">
        <AppMark />
        <div className="about-hero-copy">
          <h3 className="about-name">{t('app.name')}</h3>
          <p className="about-version" data-testid="about-version">
            {info === undefined
              ? ' '
              : t(info.release ? 'about.version' : 'about.version.development', {
                  version: info.app,
                  arch: info.arch,
                })}
          </p>
          <p className="about-tagline">{t('onboarding.welcome.lede')}</p>
        </div>
      </header>

      <SettingsSection title={t('about.updates')} testId="about-updates">
        <UpdateRow status={status} busy={busy} run={run} />
        {manual !== undefined && (
          <SettingsRow
            testId="about-manual"
            label={t('about.manual.title')}
            description={t(manual)}
          >
            {release?.pageUrl !== undefined && release.pageUrl !== '' && (
              <Button
                onClick={() => {
                  void window.piarc.openExternal(release.pageUrl);
                }}
              >
                {t('about.manual.open')}
              </Button>
            )}
          </SettingsRow>
        )}
        {error !== undefined && (
          <p className="error-text about-error" role="alert" data-testid="about-error">
            {error}
          </p>
        )}
        {showNotes && <ReleaseNotes release={release} />}
        <SettingsRow
          label={t('about.autoCheck')}
          description={t('about.autoCheck.hint')}
          descriptionId={autoCheckHint}
          htmlFor={autoCheckId}
          badge={managedAutoCheck && <ManagedBadge testId="managed-auto-check" />}
        >
          <input
            id={autoCheckId}
            type="checkbox"
            className="preference-switch"
            checked={preferences.updates.autoCheck}
            disabled={managedAutoCheck}
            aria-describedby={autoCheckHint}
            data-testid="about-auto-check"
            onChange={(event) => {
              const value = event.currentTarget.checked;
              window.piarc
                .setPreference({ key: 'updates.autoCheck', value })
                .catch((failure: unknown) => {
                  setError(t('settings.saveFailed', { reason: reason(failure) }));
                });
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={t('about.versions')}
        testId="about-versions"
        aside={
          <IconButton
            size="xs"
            label={t(copied ? 'about.copied' : 'about.copy')}
            data-testid="about-copy"
            disabled={info === undefined}
            onClick={copy}
          >
            {copied ? <CheckGlyph size={12} /> : <CopyGlyph size={12} />}
          </IconButton>
        }
      >
        <dl className="about-versions">
          {info !== undefined &&
            (
              [
                ['PiArc', info.app],
                ['Electron', info.electron],
                ['Chromium', info.chromium],
                ['Node.js', info.node],
                ['Pi', info.pi],
                [t('about.protocol'), info.protocol],
                ['libghostty-vt', info.ghostty],
                [t('about.os'), `${os} (${info.arch})`],
              ] as const
            ).map(([name, value]) => (
              <div className="about-version-row" key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </SettingsSection>

      <SettingsSection title={t('about.resources')} testId="about-links">
        <div className="about-links">
          {LINKS.map((link) => (
            <SettingsItem key={link.id} testId={`about-link-${link.id}`} name={t(link.label)}>
              <IconButton
                size="sm"
                label={t('about.link.open', { name: t(link.label) })}
                onClick={() => {
                  void window.piarc.openExternal(link.url);
                }}
              >
                <ExternalGlyph size={16} />
              </IconButton>
            </SettingsItem>
          ))}
        </div>
        <p className="about-legal">{t('about.legal')}</p>
      </SettingsSection>
    </div>
  );
}
