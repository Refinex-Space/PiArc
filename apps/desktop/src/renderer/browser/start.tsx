// The preview's start page and the failed-server card (design addendum B1.1.1, B1.6.2, B4.2,
// B4.4, B4.5). The start page lists this session's local services, the project's launch
// configurations with run, stop, open and log, the workspace's recent pages and "Open HTML
// file…". A server that failed shows its last log lines with copy, retry and "Send to agent"
// (the log goes into the session's message box as a snippet; the user sends it).
import type { DevServerState } from '@piarc/protocol';
import { useEffect, useState } from 'react';

import type { BrowserRequest, BrowserServices, BrowserStartPage } from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { attachSnippet } from '../composer/snippets.js';
import { GlobeIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';
import {
  issuePlace,
  parseStartPage,
  running,
  serverRows,
  serviceRows,
  type ServerRow,
} from './start-model.js';

/** Bytes of a running server's output the log view reads (its end). */
const LOG_BYTES = 16 * 1024;
/** Lines of a running server's log the start page shows. */
const LOG_LINES = 40;

const STATUS: Record<DevServerState['status'] | 'idle', MessageId> = {
  idle: 'browser.server.status.idle',
  starting: 'browser.server.status.starting',
  ready: 'browser.server.status.ready',
  failed: 'browser.server.status.failed',
  stopped: 'browser.server.status.stopped',
};

const FAILURE: Record<NonNullable<DevServerState['failure']>, MessageId> = {
  exited: 'browser.serverFailed.exited',
  timeout: 'browser.serverFailed.timeout',
  spawn: 'browser.serverFailed.spawn',
};

export interface StartPageProps {
  readonly sessionId: string;
  readonly services: BrowserServices | undefined;
  /** A panel request; failures are reported by the panel. */
  readonly call: (request: BrowserRequest) => void;
  /** Opens an address in the shown tab. */
  readonly open: (input: string) => void;
  readonly report: (error: unknown) => void;
}

/** The start page's recent pages and configurations, read again when the servers change. */
function useStartPage(sessionId: string, services: BrowserServices | undefined) {
  const [page, setPage] = useState<BrowserStartPage>({ recents: [] });
  const states = (services?.servers ?? []).map((s) => `${s.name}:${s.status}`).join('|');
  useEffect(() => {
    let alive = true;
    window.piarc
      .browser(sessionId, { op: 'startPage' })
      .then((value) => {
        if (alive) setPage(parseStartPage(value));
      })
      .catch((error: unknown) => {
        console.warn('[browser] the start page could not be read', error);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, states]);
  return page;
}

export function StartPage({ sessionId, services, call, open, report }: StartPageProps) {
  const t = useT();
  const page = useStartPage(sessionId, services);
  const rows = serverRows(page.launch?.configs ?? [], services);
  const local = serviceRows(services);
  const issues = page.launch?.issues ?? [];
  return (
    <div className="browser-card browser-start" data-testid="browser-start">
      <GlobeIcon size={20} />
      <p className="browser-card-title">{t('browser.start.title')}</p>
      <p>{t('browser.start.hint')}</p>
      <Button
        size="small"
        data-testid="browser-open-html"
        onClick={() => {
          call({ op: 'openHtmlFile' });
        }}
      >
        {t('browser.start.openHtml')}
      </Button>
      {local.length > 0 && (
        <section className="browser-start-section" data-testid="browser-start-services">
          <h3 className="browser-start-heading">{t('browser.start.services')}</h3>
          <ul className="browser-start-list">
            {local.map((service) => (
              <li key={service.port}>
                <button
                  type="button"
                  className="browser-start-link"
                  data-testid="browser-service"
                  data-port={service.port}
                  onClick={() => {
                    open(service.url);
                  }}
                >
                  <span>{t('browser.service.host', { port: service.port })}</span>
                  <span className="browser-start-muted">{revealBidi(service.title)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(rows.length > 0 || issues.length > 0) && (
        <section className="browser-start-section" data-testid="browser-start-servers">
          <h3 className="browser-start-heading">{t('browser.start.servers')}</h3>
          {page.launch?.trusted === false && (
            <p className="browser-start-note" data-testid="browser-start-untrusted">
              {t('browser.start.untrusted')}
            </p>
          )}
          <ul className="browser-start-list">
            {rows.map((row) => (
              <ServerItem
                key={row.config.name}
                row={row}
                trusted={page.launch?.trusted === true}
                call={call}
                open={open}
                report={report}
              />
            ))}
          </ul>
          {issues.map((issue) => (
            <p
              key={`${issuePlace(issue)} ${issue.message}`}
              className="browser-start-issue"
              data-testid="browser-start-issue"
            >
              {t('browser.start.issue', {
                path: revealBidi(issuePlace(issue)),
                message: revealBidi(issue.message),
              })}
            </p>
          ))}
        </section>
      )}
      {page.recents.length > 0 && (
        <section className="browser-start-section" data-testid="browser-start-recents">
          <h3 className="browser-start-heading">{t('browser.start.recent')}</h3>
          <ul className="browser-start-list" aria-label={t('browser.start.recentLabel')}>
            {page.recents.map((recent) => (
              <li key={recent.url}>
                <button
                  type="button"
                  className="browser-start-link"
                  data-testid="browser-recent"
                  data-url={recent.url}
                  onClick={() => {
                    open(recent.url);
                  }}
                >
                  <span>{revealBidi(recent.title === '' ? recent.url : recent.title)}</span>
                  <span className="browser-start-muted">{revealBidi(recent.url)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ServerItem({
  row,
  trusted,
  call,
  open,
  report,
}: {
  readonly row: ServerRow;
  readonly trusted: boolean;
  readonly call: (request: BrowserRequest) => void;
  readonly open: (input: string) => void;
  readonly report: (error: unknown) => void;
}) {
  const t = useT();
  const [log, setLog] = useState<string[] | undefined>(undefined);
  const { config, state } = row;
  const status = state?.status ?? 'idle';
  const taskId = state?.taskId;
  const showLog = () => {
    if (log !== undefined) {
      setLog(undefined);
      return;
    }
    if (state?.status === 'failed' && state.log !== undefined) {
      setLog(state.log);
      return;
    }
    if (taskId == null) {
      setLog([]);
      return;
    }
    readTail(taskId).then(setLog, report);
  };
  return (
    <li
      className="browser-server"
      data-testid="browser-server"
      data-name={config.name}
      data-status={status}
    >
      <div className="browser-server-head">
        <span className="browser-server-name">{revealBidi(config.name)}</span>
        <span className="browser-start-muted" data-testid="browser-server-status">
          {t(STATUS[status])}
        </span>
      </div>
      <code className="browser-server-command">{revealBidi(config.command)}</code>
      <div className="browser-server-actions">
        {running(state) ? (
          <Button
            size="small"
            data-testid="browser-server-stop"
            onClick={() => {
              call({ op: 'stopServer', name: config.name });
            }}
          >
            {t('browser.server.stop')}
          </Button>
        ) : (
          <Button
            size="small"
            disabled={!trusted}
            data-testid="browser-server-run"
            onClick={() => {
              call({ op: 'startServer', name: config.name });
            }}
          >
            {t('browser.server.run')}
          </Button>
        )}
        <Button
          size="small"
          variant="ghost"
          disabled={status !== 'ready'}
          data-testid="browser-server-open"
          onClick={() => {
            open(state?.url ?? config.url);
          }}
        >
          {t('browser.server.open')}
        </Button>
        <Button
          size="small"
          variant="ghost"
          aria-expanded={log !== undefined}
          disabled={state === undefined}
          data-testid="browser-server-log"
          onClick={showLog}
        >
          {t('browser.server.log')}
        </Button>
      </div>
      {log !== undefined && (
        <pre className="browser-server-log" data-testid="browser-server-log-text">
          {log.length === 0 ? t('browser.server.logEmpty') : revealBidi(log.join('\n'))}
        </pre>
      )}
    </li>
  );
}

/** The last lines of a task's output. */
async function readTail(taskId: string): Promise<string[]> {
  const total = totalBytes(await window.piarc.readTaskOutput(taskId, 0, 1));
  const chunk: unknown = JSON.parse(
    await window.piarc.readTaskOutput(taskId, Math.max(0, total - LOG_BYTES), LOG_BYTES),
  );
  const text =
    typeof chunk === 'object' && chunk !== null && 'text' in chunk && typeof chunk.text === 'string'
      ? chunk.text
      : '';
  return text
    .split(/\r?\n/)
    .filter((line, i, all) => line !== '' || i < all.length - 1)
    .slice(-LOG_LINES);
}

function totalBytes(json: string): number {
  const chunk: unknown = JSON.parse(json);
  return typeof chunk === 'object' &&
    chunk !== null &&
    'totalBytes' in chunk &&
    typeof chunk.totalBytes === 'number'
    ? chunk.totalBytes
    : 0;
}

/** B4.5: a server that exited or did not become ready, with its last log lines. */
export function ServerFailed({
  sessionId,
  server,
  call,
  onDismiss,
}: {
  readonly sessionId: string;
  readonly server: DevServerState;
  readonly call: (request: BrowserRequest) => void;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const log = server.log ?? [];
  const text = log.join('\n');
  return (
    <div
      className="browser-prompt browser-server-failed"
      role="alert"
      data-testid="browser-server-failed"
      data-name={server.name}
    >
      <div className="browser-prompt-text">
        <strong>{t(FAILURE[server.failure ?? 'exited'], { name: revealBidi(server.name) })}</strong>
        {server.exitCode != null && (
          <span className="browser-prompt-detail">
            {t('browser.serverFailed.code', { code: server.exitCode })}
          </span>
        )}
        <pre className="browser-server-log" data-testid="browser-server-failed-log">
          {log.length === 0 ? t('browser.serverFailed.empty') : revealBidi(text)}
        </pre>
      </div>
      <Button
        size="small"
        disabled={log.length === 0}
        data-testid="browser-server-copy"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? t('browser.serverFailed.copied') : t('browser.serverFailed.copy')}
      </Button>
      <Button
        size="small"
        data-testid="browser-server-retry"
        onClick={() => {
          onDismiss();
          call({ op: 'startServer', name: server.name });
        }}
      >
        {t('browser.serverFailed.retry')}
      </Button>
      <Button
        size="small"
        variant="primary"
        disabled={log.length === 0}
        data-testid="browser-server-send"
        onClick={() => {
          attachSnippet(sessionId, {
            label: t('browser.serverFailed.snippet', { name: server.name, lines: log.length }),
            source: `Development server ${server.name}`,
            text,
          });
          onDismiss();
          // The message box is in the workbench, also when the preview is popped out.
          requestAnimationFrame(() => {
            window.document.querySelector<HTMLElement>('.composer-editor')?.focus();
          });
        }}
      >
        {t('browser.serverFailed.send')}
      </Button>
      <Button size="small" variant="ghost" data-testid="browser-server-dismiss" onClick={onDismiss}>
        {t('browser.serverFailed.dismiss')}
      </Button>
    </div>
  );
}
