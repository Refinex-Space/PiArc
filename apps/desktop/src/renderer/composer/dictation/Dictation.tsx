// The composer's dictation controls (voice dictation addendum 3.2): the microphone button next
// to send, which turns into "stop dictation" while recording, and the dictation strip that takes
// the action row with cancel, the state in words, the live waveform and the elapsed time. Errors stay
// in the strip with an action; the draft is never touched by them.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { EditorView } from 'prosemirror-view';

import { IconButton } from '../../app/IconButton.js';
import { useApp } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import { CloseGlyph, MicIcon, SpinnerGlyph, StopDictationIcon } from '../../shell/icons.js';
import { dictationRoute, onDictationEvents, onDictationToggle } from './bus.js';
import { DictationController, type DictationApi, type DictationUi } from './controller.js';
import { Waveform } from './Waveform.js';

/** How long preparing may take before the strip says so (addendum V-2.2). */
const PREPARING_HINT_MS = 300;
/** How long a notice stays. */
const NOTICE_MS = 5000;

/** Which composer this is, for Core's owner record and the trusted workspace's vocabulary. */
export interface DictationTarget {
  /** `session:<id>` or `workspace:<path>`. */
  readonly composer: string;
  readonly workspace?: string;
}

function parseStarted(text: string): { sessionId: string; route: string } {
  const value: unknown = JSON.parse(text);
  if (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'route' in value &&
    typeof value.route === 'string'
  ) {
    return { sessionId: value.sessionId, route: value.route };
  }
  throw new TypeError('unexpected dictation start answer');
}

const WINDOW_API: DictationApi = {
  start: (request) => window.piarc.dictationStart(request).then(parseStarted),
  stop: (sessionId, mode) => window.piarc.dictationStop(sessionId, mode),
  cancel: (sessionId) => window.piarc.dictationCancel(sessionId),
  route: dictationRoute,
  subscribe: (_route, listener) => onDictationEvents(listener),
  now: () => performance.now(),
};

/** A composer's dictation: the controller, its UI state, the notice and the announcement. */
export function useDictation(
  view: RefObject<EditorView | null>,
  target: DictationTarget | undefined,
): {
  readonly controller: DictationController | undefined;
  readonly ui: DictationUi;
  readonly notice: string | undefined;
  readonly announcement: string;
} {
  const [ui, setUi] = useState<DictationUi>({ kind: 'idle' });
  const [notice, setNotice] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const targetRef = useRef(target);
  targetRef.current = target;
  const composer = target?.composer;
  const controller = useMemo(
    () =>
      composer === undefined
        ? undefined
        : new DictationController(
            () => view.current,
            WINDOW_API,
            {
              state: setUi,
              notice: (code) => {
                setNotice(code);
              },
              announce: setAnnouncement,
            },
            composer,
            () => targetRef.current?.workspace,
          ),
    [composer, view],
  );
  useEffect(() => {
    if (controller === undefined) return undefined;
    void controller.attach().catch(() => undefined);
    return () => {
      controller.detach();
    };
  }, [controller]);
  useEffect(() => {
    if (controller === undefined) return undefined;
    // Opening the settings stops dictation and keeps its text (addendum V-5.2, ADR-0074).
    const settingsOpened = () => {
      if (window.location.hash.startsWith('#/settings')) controller.stop();
    };
    window.addEventListener('hashchange', settingsOpened);
    const stopToggle = onDictationToggle(() => {
      if (controller.active) controller.stop();
      else void controller.start();
    });
    return () => {
      window.removeEventListener('hashchange', settingsOpened);
      stopToggle();
    };
  }, [controller]);
  useEffect(() => {
    if (notice === undefined) return undefined;
    const timer = setTimeout(() => {
      setNotice(undefined);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  return { controller, ui, notice, announcement };
}

/** The microphone column: start, stop while recording, a spinner while busy. */
export function MicButton({
  controller,
  ui,
  disabled,
}: {
  readonly controller: DictationController;
  readonly ui: DictationUi;
  readonly disabled: boolean;
}) {
  const { t } = useApp();
  switch (ui.kind) {
    case 'recording':
      return (
        <IconButton
          key="stop"
          label={t('dictation.stop')}
          keys="Escape"
          size="sm"
          className="composer-mic is-recording"
          data-testid="dictation-stop"
          aria-pressed="true"
          onClick={() => {
            controller.stop();
          }}
        >
          <StopDictationIcon />
        </IconButton>
      );
    case 'starting':
    case 'preparing':
    case 'finalizing':
      return (
        <IconButton
          key="busy"
          label={t(ui.kind === 'finalizing' ? 'dictation.finishing' : 'dictation.cancelPreparing')}
          size="sm"
          className="composer-mic is-busy"
          data-testid="dictation-busy"
          aria-busy="true"
          disabled={ui.kind === 'finalizing'}
          onClick={() => {
            controller.cancel();
          }}
        >
          <SpinnerGlyph size={16} />
        </IconButton>
      );
    case 'idle':
    case 'error':
      return (
        <IconButton
          key="start"
          label={t('dictation.start')}
          size="sm"
          className="composer-mic"
          data-testid="composer-mic"
          disabled={disabled}
          onClick={() => {
            void controller.start();
          }}
        >
          <MicIcon />
        </IconButton>
      );
  }
}

const ERROR_TEXT: Readonly<Record<string, MessageId>> = {
  microphoneDenied: 'dictation.error.microphoneDenied',
  microphoneUnavailable: 'dictation.error.microphoneUnavailable',
  deviceLost: 'dictation.error.deviceLost',
  runtimeMissing: 'dictation.error.model',
  modelMissing: 'dictation.error.model',
  modelCorrupt: 'dictation.error.model',
  loadFailed: 'dictation.error.model',
  busy: 'dictation.error.busy',
  disabled: 'dictation.error.disabled',
  sendTimeout: 'dictation.error.sendTimeout',
  windowHidden: 'dictation.error.windowHidden',
};

const NOTICE_TEXT: Readonly<Record<string, MessageId>> = {
  maxDuration: 'dictation.notice.maxDuration',
  noSpeech: 'dictation.notice.noSpeech',
  deviceLost: 'dictation.notice.deviceLost',
  deviceFallback: 'dictation.notice.deviceFallback',
  overflow: 'dictation.notice.overflow',
  refineTimeout: 'dictation.notice.refineKept',
  refineFailed: 'dictation.notice.refineKept',
  refineSkipped: 'dictation.notice.refineKept',
  enhancedUnavailable: 'dictation.notice.enhancedUnavailable',
  kept: 'dictation.notice.kept',
};

function Elapsed({ since }: { readonly since: number }) {
  const { format } = useApp();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(performance.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  return (
    <span className="dictation-elapsed" data-testid="dictation-elapsed">
      {`${format.number(minutes)}:${format.number(seconds % 60, { minimumIntegerDigits: 2 })}`}
    </span>
  );
}

function PreparingText({ since }: { readonly since: number }) {
  const { t } = useApp();
  const [shown, setShown] = useState(() => performance.now() - since >= PREPARING_HINT_MS);
  useEffect(() => {
    if (shown) return undefined;
    const timer = setTimeout(() => {
      setShown(true);
    }, PREPARING_HINT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [shown]);
  return shown ? <span>{t('dictation.preparing')}</span> : null;
}

/** Whether the strip takes the composer's action row: while dictating, failed, or with a notice. */
export function dictationShown(ui: DictationUi, notice: string | undefined): boolean {
  return ui.kind !== 'idle' || (notice !== undefined && NOTICE_TEXT[notice] !== undefined);
}

/**
 * The strip that takes the composer's action row while dictation is active or failed (the
 * microphone and send keep their places): cancel where `+` was, the state in words when there is
 * something to say, the live waveform across the row, and the recording mark with the elapsed time
 * next to the stop button. Errors and notices replace the waveform with their text and action.
 */
export function DictationBar({
  controller,
  ui,
  notice,
  announcement,
  reducedMotion,
}: {
  readonly controller: DictationController;
  readonly ui: DictationUi;
  readonly notice: string | undefined;
  readonly announcement: string;
  readonly reducedMotion: boolean;
}) {
  const { t } = useApp();
  const noticeId = notice === undefined ? undefined : NOTICE_TEXT[notice];
  const status = (() => {
    switch (ui.kind) {
      case 'idle':
        return null;
      case 'starting':
        return null;
      case 'preparing':
        return <PreparingText since={ui.since} />;
      case 'recording':
        return (
          <>
            <span className="dictation-dot" aria-hidden="true" />
            <span className="visually-hidden">{t('dictation.listening')}</span>
            <Elapsed since={ui.since} />
          </>
        );
      case 'finalizing':
        return <span>{t('dictation.finishing')}</span>;
      case 'error':
        return <span>{t(ERROR_TEXT[ui.code] ?? 'dictation.error.unknown')}</span>;
    }
  })();
  const statusSpan = (
    <span className="dictation-status" data-testid="dictation-status">
      {status}
    </span>
  );
  const actions =
    ui.kind === 'error' ? <ErrorActions code={ui.code} controller={controller} /> : null;
  const waving = ui.kind !== 'error' && ui.kind !== 'idle';
  return (
    <>
      {dictationShown(ui, notice) && (
        <div
          className={`composer-dictation is-${ui.kind}`}
          data-testid="composer-dictation"
          data-state={ui.kind}
        >
          <IconButton
            label={t(
              ui.kind === 'error' || ui.kind === 'idle' ? 'dictation.dismiss' : 'dictation.cancel',
            )}
            size="sm"
            className="dictation-cancel"
            data-testid="dictation-cancel"
            onClick={() => {
              if (ui.kind === 'error' || ui.kind === 'idle') controller.dismiss();
              else controller.cancel();
            }}
          >
            <CloseGlyph />
          </IconButton>
          {ui.kind !== 'recording' && statusSpan}
          {noticeId !== undefined && ui.kind !== 'error' && (
            <span className="dictation-notice">{t(noticeId)}</span>
          )}
          {actions}
          {waving && (
            <Waveform
              levels={controller.levels}
              live={ui.kind === 'recording'}
              reducedMotion={reducedMotion}
            />
          )}
          {ui.kind === 'recording' && statusSpan}
        </div>
      )}
      <div className="visually-hidden" aria-live="polite" data-testid="dictation-live">
        {ui.kind === 'recording'
          ? t('dictation.announce.listening')
          : ui.kind === 'error'
            ? t(ERROR_TEXT[ui.code] ?? 'dictation.error.unknown')
            : announcement}
      </div>
    </>
  );
}

function ErrorActions({
  code,
  controller,
}: {
  readonly code: string;
  readonly controller: DictationController;
}) {
  const { t } = useApp();
  const action = (label: MessageId, testId: string, run: () => void) => (
    <button type="button" className="dictation-action" data-testid={testId} onClick={run}>
      {t(label)}
    </button>
  );
  if (code === 'microphoneDenied') {
    return action('dictation.action.systemSettings', 'dictation-open-system', () => {
      void window.piarc.openMicrophoneSettings();
    });
  }
  if (code === 'busy') {
    return action('dictation.action.ownerWindow', 'dictation-owner', () => {
      void window.piarc.focusDictationOwner();
    });
  }
  if (ERROR_TEXT[code] === 'dictation.error.model' || code === 'disabled') {
    return action('dictation.action.voiceSettings', 'dictation-open-settings', () => {
      void window.piarc.openSettings('voice');
    });
  }
  return action('dictation.action.retry', 'dictation-retry', () => {
    void controller.start();
  });
}
