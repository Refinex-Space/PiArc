// The "Voice input" settings page (voice dictation addendum 3.8): turn dictation on or off, the
// microphone and its test, the recognition mode and the models, punctuation, terms, the user's
// dictionary and the privacy note. Values are the user's own (`voiceDictation.*` through the
// preference channel); model files are Core's (`speechModels`, `core/speech`). The microphone
// test is a level-only dictation session: it never writes text and stops when the page goes.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import {
  type PreferenceChange,
  VOICE_MODES,
  type VoiceTermProblem,
  voiceTermProblem,
} from '../../shared/preferences.js';
import { Button } from '../app/Button.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { DictationController, type DictationUi } from '../composer/dictation/controller.js';
import { dictationRoute, onDictationEvents } from '../composer/dictation/bus.js';
import { Waveform } from '../composer/dictation/Waveform.js';
import {
  onSpeechModels,
  parseSpeechModels,
  type SpeechModelState,
  type SpeechModelView,
} from './voice-settings.js';
import { useIsManaged, ManagedBadge } from './managed.js';

const STATE_TEXT: Readonly<Record<SpeechModelState, MessageId>> = {
  ready: 'settings.voice.state.ready',
  missing: 'settings.voice.state.missing',
  corrupt: 'settings.voice.state.corrupt',
  downloading: 'settings.voice.state.downloading',
  verifying: 'settings.voice.state.verifying',
  failed: 'settings.voice.state.failed',
};

const TERM_TEXT: Readonly<Record<VoiceTermProblem, MessageId>> = {
  empty: 'settings.voice.term.empty',
  tooLong: 'settings.voice.term.tooLong',
  forbidden: 'settings.voice.term.forbidden',
  notEncodable: 'settings.voice.term.notEncodable',
};

/** Megabytes in the app's language ("1,066 MB"). */
function megabytes(format: ReturnType<typeof useApp>['format'], bytes: number): string {
  return format.number(bytes / 1_000_000, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 0,
  });
}

interface Device {
  readonly id: string;
  readonly name: string;
  readonly default: boolean;
}

function parseDevices(raw: string): readonly Device[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) =>
    typeof entry === 'object' &&
    entry !== null &&
    'id' in entry &&
    typeof entry.id === 'string' &&
    'name' in entry &&
    typeof entry.name === 'string'
      ? [{ id: entry.id, name: entry.name, default: 'default' in entry && entry.default === true }]
      : [],
  );
}

function Section({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-subsection" data-testid={testId}>
      <h2 className="permission-heading">{title}</h2>
      {children}
    </section>
  );
}

function Check({
  checked,
  label,
  hint,
  testId,
  onChange,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly testId: string;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  const hintId = useId();
  return (
    <div className="setting">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          data-testid={testId}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
          onChange={(e) => {
            onChange(e.currentTarget.checked);
          }}
        />
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A level-only microphone test, stopped when the page goes away. */
function MicrophoneTest({ disabled }: { readonly disabled: boolean }) {
  const { t, preferences } = useApp();
  const [ui, setUi] = useState<DictationUi>({ kind: 'idle' });
  const controller = useRef<DictationController>(undefined);
  controller.current ??= new DictationController(
    () => null,
    {
      start: (request) =>
        window.piarc.dictationStart({ ...request, test: true }).then((text) => {
          const value: unknown = JSON.parse(text);
          if (
            typeof value === 'object' &&
            value !== null &&
            'sessionId' in value &&
            typeof value.sessionId === 'string'
          ) {
            return { sessionId: value.sessionId, route: '' };
          }
          throw new TypeError('unexpected dictation start answer');
        }),
      stop: (id, mode) => window.piarc.dictationStop(id, mode),
      cancel: (id) => window.piarc.dictationCancel(id),
      route: dictationRoute,
      subscribe: (_route, listener) => onDictationEvents(listener),
      now: () => performance.now(),
    },
    { state: setUi, notice: () => undefined, announce: () => undefined },
    'settings:',
    () => undefined,
  );
  useEffect(
    () => () => {
      controller.current?.detach();
    },
    [],
  );
  const testing = ui.kind === 'starting' || ui.kind === 'preparing' || ui.kind === 'recording';
  const motion = preferences.appearance.reduceMotion;
  const reduced =
    motion === 'on' ||
    (motion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return (
    <div className="setting voice-test" data-testid="voice-test">
      <Button
        size="small"
        disabled={disabled && !testing}
        data-testid="voice-test-button"
        onClick={() => {
          if (testing) controller.current?.stop();
          else void controller.current?.start(true);
        }}
      >
        {testing ? t('settings.voice.testStop') : t('settings.voice.test')}
      </Button>
      {testing && (
        <Waveform
          levels={controller.current.levels}
          live={ui.kind === 'recording'}
          reducedMotion={reduced}
        />
      )}
      {ui.kind === 'error' && (
        <p className="error-text" role="alert" data-testid="voice-test-error">
          {t(
            ui.code === 'microphoneDenied'
              ? 'dictation.error.microphoneDenied'
              : 'dictation.error.microphoneUnavailable',
          )}
        </p>
      )}
    </div>
  );
}

export function VoicePage() {
  const { t, preferences, format } = useApp();
  const voice = preferences.voiceDictation;
  const [devices, setDevices] = useState<readonly Device[]>([]);
  const [models, setModels] = useState<readonly SpeechModelView[]>([]);
  const [term, setTerm] = useState('');
  const [termError, setTermError] = useState('');
  const [error, setError] = useState('');
  const managed = useIsManaged('/voiceDictation/enabled');
  const modeLabel = useId();

  const save = (change: PreferenceChange) => {
    setError('');
    window.piarc.setPreference(change).catch((e: unknown) => {
      setError(t('settings.saveFailed', { reason: reason(e) }));
    });
  };

  const loadDevices = useCallback(() => {
    window.piarc
      .speechDevices()
      .then((raw) => {
        setDevices(parseDevices(raw));
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
  }, []);

  const loadModels = useCallback(() => {
    window.piarc
      .speechModels()
      .then((raw) => {
        setModels(parseSpeechModels(raw));
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
  }, []);

  useEffect(() => {
    loadModels();
    return onSpeechModels((raw) => {
      setModels(parseSpeechModels(raw));
    });
  }, [loadModels]);

  const chosenMissing =
    voice.device !== null && devices.length > 0 && !devices.some((d) => d.id === voice.device);
  const base = models.find((m) => m.kind === 'base');
  const enhanced = models.find((m) => m.kind === 'enhanced');

  const addTerm = () => {
    const value = term.trim();
    const problem = voiceTermProblem(value);
    if (problem !== undefined) {
      setTermError(t(TERM_TEXT[problem]));
      return;
    }
    if (voice.customTerms.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
      setTermError(t('settings.voice.term.duplicate'));
      return;
    }
    setTermError('');
    setTerm('');
    save({ key: 'voiceDictation.customTerms', value: [...voice.customTerms, value] });
  };

  return (
    <div className="settings-section settings-detail-page" data-testid="voice-page">
      <p className="muted">{t('settings.voice.intro')}</p>
      {error !== '' && (
        <p className="error-text" role="alert" data-testid="voice-settings-error">
          {error}
        </p>
      )}

      <Section title={t('settings.voice.general')} testId="voice-general">
        <Check
          checked={voice.enabled}
          disabled={managed}
          label={t('settings.voice.enabled')}
          hint={t('settings.voice.enabledHint')}
          testId="voice-enabled"
          onChange={(value) => {
            save({ key: 'voiceDictation.enabled', value });
          }}
        />
        {managed && <ManagedBadge />}
        <div className="setting">
          <label className="setting-label" htmlFor="voice-device">
            {t('settings.voice.device')}
          </label>
          <div className="voice-row">
            <select
              id="voice-device"
              className="input"
              data-testid="voice-device"
              value={voice.device ?? ''}
              onFocus={loadDevices}
              onChange={(event) => {
                const value = event.currentTarget.value;
                save({ key: 'voiceDictation.device', value: value === '' ? null : value });
              }}
            >
              <option value="">{t('settings.voice.deviceDefault')}</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
              {chosenMissing && (
                <option value={voice.device}>{t('settings.voice.deviceMissing')}</option>
              )}
            </select>
            <Button
              variant="ghost"
              size="small"
              data-testid="voice-device-refresh"
              onClick={loadDevices}
            >
              {t('settings.voice.refresh')}
            </Button>
          </div>
          {chosenMissing && <p className="muted">{t('settings.voice.deviceMissingHint')}</p>}
        </div>
        <MicrophoneTest disabled={!voice.enabled} />
      </Section>

      <Section title={t('settings.voice.mode')} testId="voice-mode">
        <fieldset className="setting">
          <legend id={modeLabel} className="setting-label">
            {t('settings.voice.mode')}
          </legend>
          <SegmentedControl
            options={VOICE_MODES}
            value={voice.mode}
            name="voice-mode"
            testIdPrefix="voice-mode"
            aria-labelledby={modeLabel}
            // Enhanced needs its model; a user on enhanced can always go back to basic.
            disabled={voice.mode === 'basic' && enhanced?.state !== 'ready'}
            labelOf={(mode) =>
              t(mode === 'basic' ? 'settings.voice.modeBasic' : 'settings.voice.modeEnhanced')
            }
            onChange={(value) => {
              save({ key: 'voiceDictation.mode', value });
            }}
          />
          <p className="muted">
            {t(
              enhanced?.state === 'ready'
                ? 'settings.voice.modeHint'
                : 'settings.voice.modeNeedsModel',
            )}
          </p>
        </fieldset>
        <div className="setting" data-testid="voice-model-base">
          <span className="setting-label">{t('settings.voice.modelBase')}</span>
          <p className="muted">
            {t('settings.voice.modelBaseHint', {
              version: base?.version ?? '',
              size: megabytes(format, base?.installedBytes ?? 0),
            })}
          </p>
          <p className="muted" data-testid="voice-model-base-state">
            {t(STATE_TEXT[base?.state ?? 'missing'])}
          </p>
        </div>
        {enhanced !== undefined && <EnhancedModel model={enhanced} reload={loadModels} />}
      </Section>

      <Section title={t('settings.voice.recognition')} testId="voice-recognition">
        <Check
          checked={voice.punctuation}
          label={t('settings.voice.punctuation')}
          hint={t('settings.voice.punctuationHint')}
          testId="voice-punctuation"
          onChange={(value) => {
            save({ key: 'voiceDictation.punctuation', value });
          }}
        />
        <Check
          checked={voice.techTerms}
          label={t('settings.voice.techTerms')}
          hint={t('settings.voice.techTermsHint')}
          testId="voice-tech-terms"
          onChange={(value) => {
            save({ key: 'voiceDictation.techTerms', value });
          }}
        />
        <Check
          checked={voice.workspaceTerms}
          label={t('settings.voice.workspaceTerms')}
          hint={t('settings.voice.workspaceTermsHint')}
          testId="voice-workspace-terms"
          onChange={(value) => {
            save({ key: 'voiceDictation.workspaceTerms', value });
          }}
        />
        <div className="setting" data-testid="voice-dictionary">
          <span className="setting-label">{t('settings.voice.dictionary')}</span>
          <p className="muted">{t('settings.voice.dictionaryHint')}</p>
          {voice.customTerms.length > 0 && (
            <ul className="voice-terms" data-testid="voice-terms">
              {voice.customTerms.map((entry) => (
                <li key={entry} className="voice-term" data-testid="voice-term">
                  <span>{entry}</span>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label={t('settings.voice.removeTerm', { term: entry })}
                    onClick={() => {
                      save({
                        key: 'voiceDictation.customTerms',
                        value: voice.customTerms.filter((existing) => existing !== entry),
                      });
                    }}
                  >
                    {t('settings.voice.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="voice-row"
            onSubmit={(event) => {
              event.preventDefault();
              addTerm();
            }}
          >
            <input
              className="input"
              data-testid="voice-term-input"
              aria-label={t('settings.voice.addTerm')}
              maxLength={64}
              value={term}
              onChange={(event) => {
                setTerm(event.currentTarget.value);
                setTermError('');
              }}
            />
            <Button type="submit" size="small" data-testid="voice-term-add">
              {t('settings.voice.add')}
            </Button>
          </form>
          {termError !== '' && (
            <p className="error-text" role="alert" data-testid="voice-term-error">
              {termError}
            </p>
          )}
        </div>
      </Section>

      <p className="voice-privacy muted" data-testid="voice-privacy">
        {t('settings.voice.privacy')}
      </p>
    </div>
  );
}

/** The enhanced model: size, download, progress, cancel, retry, delete. */
function EnhancedModel({
  model,
  reload,
}: {
  readonly model: SpeechModelView;
  readonly reload: () => void;
}) {
  const { t, format } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = (op: 'download' | 'cancel' | 'delete' | 'verify') => {
    setBusy(true);
    setError('');
    window.piarc
      .speechModelAction(model.id, op)
      .then(reload)
      .catch((e: unknown) => {
        setError(reason(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const downloading = model.state === 'downloading' || model.state === 'verifying';
  const percent =
    model.receivedBytes === undefined || model.downloadBytes === 0
      ? 0
      : Math.min(100, Math.floor((model.receivedBytes / model.downloadBytes) * 100));
  return (
    <div className="setting" data-testid="voice-model-enhanced">
      <span className="setting-label">{t('settings.voice.modelEnhanced')}</span>
      <p className="muted">
        {t('settings.voice.modelEnhancedHint', {
          size: megabytes(format, model.downloadBytes),
          disk: megabytes(format, model.installedBytes),
        })}
      </p>
      <p className="muted" data-testid="voice-model-enhanced-state">
        {downloading
          ? t('settings.voice.downloading', { percent: format.number(percent) })
          : t(STATE_TEXT[model.state])}
        {model.error !== undefined && ` · ${t('settings.voice.downloadFailed')}`}
      </p>
      {downloading && (
        <progress
          className="voice-progress"
          max={100}
          value={percent}
          aria-label={t('settings.voice.downloadProgress')}
          data-testid="voice-download-progress"
        />
      )}
      <div className="voice-row">
        {model.state === 'missing' || model.state === 'failed' || model.state === 'corrupt' ? (
          <Button
            size="small"
            disabled={busy}
            data-testid="voice-download"
            onClick={() => {
              act('download');
            }}
          >
            {model.state === 'missing' ? t('settings.voice.download') : t('settings.voice.retry')}
          </Button>
        ) : null}
        {downloading && (
          <Button
            variant="ghost"
            size="small"
            data-testid="voice-download-cancel"
            onClick={() => {
              act('cancel');
            }}
          >
            {t('dialog.cancel')}
          </Button>
        )}
        {model.state === 'ready' && (
          <Button
            variant="destructive"
            size="small"
            disabled={busy || model.active}
            data-testid="voice-model-delete"
            onClick={() => {
              act('delete');
            }}
          >
            {t('settings.voice.delete')}
          </Button>
        )}
      </div>
      {model.active && <p className="muted">{t('settings.voice.deleteActive')}</p>}
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
