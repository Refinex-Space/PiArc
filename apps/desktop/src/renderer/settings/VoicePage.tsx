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
  const { t, preferences } = useApp();
  const voice = preferences.voiceDictation;
  const [devices, setDevices] = useState<readonly Device[]>([]);
  const [models, setModels] = useState<readonly SpeechModelView[]>([]);
  const [term, setTerm] = useState('');
  const [termError, setTermError] = useState('');
  const [error, setError] = useState('');
  const managed = useIsManaged('/voiceDictation/enabled');
  // Managed settings may lock any of these (T47); a locked control shows why and stays put.
  const locked = {
    device: useIsManaged('/voiceDictation/device'),
    mode: useIsManaged('/voiceDictation/mode'),
    punctuation: useIsManaged('/voiceDictation/punctuation'),
    techTerms: useIsManaged('/voiceDictation/techTerms'),
    workspaceTerms: useIsManaged('/voiceDictation/workspaceTerms'),
    customTerms: useIsManaged('/voiceDictation/customTerms'),
  };
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
              disabled={locked.device}
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
            {locked.device && <ManagedBadge />}
          </div>
          {chosenMissing && <p className="muted">{t('settings.voice.deviceMissingHint')}</p>}
        </div>
        <MicrophoneTest disabled={!voice.enabled} />
      </Section>

      <Section title={t('settings.voice.models')} testId="voice-mode">
        <div className="preference-rows voice-models">
          <div className="preference-row">
            <span className="preference-copy">
              <span id={modeLabel}>
                {t('settings.voice.mode')}
                {locked.mode && <ManagedBadge />}
              </span>
              <span className="preference-description">
                {t(
                  enhanced?.state === 'ready'
                    ? 'settings.voice.modeHint'
                    : 'settings.voice.modeNeedsModel',
                )}
              </span>
            </span>
            <SegmentedControl
              options={VOICE_MODES}
              value={voice.mode}
              name="voice-mode"
              testIdPrefix="voice-mode"
              aria-labelledby={modeLabel}
              // Enhanced needs its model; a user on enhanced can always go back to basic.
              disabled={locked.mode || (voice.mode === 'basic' && enhanced?.state !== 'ready')}
              labelOf={(mode) =>
                t(mode === 'basic' ? 'settings.voice.modeBasic' : 'settings.voice.modeEnhanced')
              }
              onChange={(value) => {
                save({ key: 'voiceDictation.mode', value });
              }}
            />
          </div>
          {base !== undefined && <BaseModel model={base} reload={loadModels} />}
          {enhanced !== undefined && (
            <EnhancedModel
              model={enhanced}
              reload={loadModels}
              enable={(on) =>
                window.piarc.setPreference({
                  key: 'voiceDictation.mode',
                  value: on ? 'enhanced' : 'basic',
                })
              }
              canEnable={!locked.mode}
            />
          )}
        </div>
      </Section>

      <Section title={t('settings.voice.recognition')} testId="voice-recognition">
        <Check
          checked={voice.punctuation}
          disabled={locked.punctuation}
          label={t('settings.voice.punctuation')}
          hint={t('settings.voice.punctuationHint')}
          testId="voice-punctuation"
          onChange={(value) => {
            save({ key: 'voiceDictation.punctuation', value });
          }}
        />
        <Check
          checked={voice.techTerms}
          disabled={locked.techTerms}
          label={t('settings.voice.techTerms')}
          hint={t('settings.voice.techTermsHint')}
          testId="voice-tech-terms"
          onChange={(value) => {
            save({ key: 'voiceDictation.techTerms', value });
          }}
        />
        <Check
          checked={voice.workspaceTerms}
          disabled={locked.workspaceTerms}
          label={t('settings.voice.workspaceTerms')}
          hint={t('settings.voice.workspaceTermsHint')}
          testId="voice-workspace-terms"
          onChange={(value) => {
            save({ key: 'voiceDictation.workspaceTerms', value });
          }}
        />
        <div className="setting" data-testid="voice-dictionary">
          <span className="setting-label">
            {t('settings.voice.dictionary')}
            {locked.customTerms && <ManagedBadge />}
          </span>
          <p className="muted">{t('settings.voice.dictionaryHint')}</p>
          {voice.customTerms.length > 0 && (
            <ul className="voice-terms" data-testid="voice-terms">
              {voice.customTerms.map((entry) => (
                <li key={entry} className="voice-term" data-testid="voice-term">
                  <span>{entry}</span>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={locked.customTerms}
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
              disabled={locked.customTerms}
              value={term}
              onChange={(event) => {
                setTerm(event.currentTarget.value);
                setTermError('');
              }}
            />
            <Button
              type="submit"
              size="small"
              disabled={locked.customTerms}
              data-testid="voice-term-add"
            >
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

/** How a model's state is drawn: done, in progress, needing attention, or absent. */
const STATE_TONE: Readonly<Record<SpeechModelState, 'success' | 'progress' | 'danger' | 'idle'>> = {
  ready: 'success',
  downloading: 'progress',
  verifying: 'progress',
  corrupt: 'danger',
  failed: 'danger',
  missing: 'idle',
};

/**
 * One model as a settings row: its name with a state tag and one line about it on the left,
 * notes and progress under that line, its actions on the right.
 */
function ModelRow({
  kind,
  name,
  state,
  stateText,
  description,
  actions,
  children,
}: {
  readonly kind: 'base' | 'enhanced';
  readonly name: string;
  readonly state: SpeechModelState;
  readonly stateText: string;
  readonly description: string;
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="preference-row voice-model" data-testid={`voice-model-${kind}`}>
      <span className="preference-copy">
        <span className="voice-model-title">
          <span>{name}</span>
          <span
            className={`voice-model-state is-${STATE_TONE[state]}`}
            data-testid={`voice-model-${kind}-state`}
          >
            {stateText}
          </span>
        </span>
        <span className="preference-description">{description}</span>
        {children}
      </span>
      <span className="voice-model-actions">{actions}</span>
    </div>
  );
}

/**
 * "Verify": Core checks every file's size and SHA-256 now (V-8.2); the answer replaces the
 * quick, size-only state. Gives the button and the line that reports the result.
 */
function useVerify(model: SpeechModelView, reload: () => void) {
  const { t } = useApp();
  const [state, setState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [error, setError] = useState('');
  const button = (
    <Button
      size="small"
      loading={state === 'busy'}
      data-testid={`voice-verify-${model.kind}`}
      onClick={() => {
        setState('busy');
        setError('');
        window.piarc
          .speechModelAction(model.id, 'verify')
          .then(() => {
            setState('ok');
            reload();
          })
          .catch((e: unknown) => {
            setState('idle');
            setError(reason(e));
            reload();
          });
      }}
    >
      {t('settings.voice.verify')}
    </Button>
  );
  const result =
    state === 'ok' ? (
      <span className="voice-model-ok" role="status" data-testid={`voice-verified-${model.kind}`}>
        {t('settings.voice.verified')}
      </span>
    ) : error !== '' ? (
      <span className="error-text" role="alert">
        {error}
      </span>
    ) : null;
  return { button, result };
}

/** The built-in model: version and size, its state, verify (repair is a reinstall). */
function BaseModel({
  model,
  reload,
}: {
  readonly model: SpeechModelView;
  readonly reload: () => void;
}) {
  const { t, format } = useApp();
  const verify = useVerify(model, reload);
  return (
    <ModelRow
      kind="base"
      name={t('settings.voice.modelBase')}
      state={model.state}
      stateText={t(STATE_TEXT[model.state])}
      description={t('settings.voice.modelBaseHint', {
        version: model.version,
        size: megabytes(format, model.installedBytes),
      })}
      actions={verify.button}
    >
      {verify.result}
      {model.state !== 'ready' && (
        <span className="preference-description">{t('settings.voice.repairHint')}</span>
      )}
    </ModelRow>
  );
}

/**
 * The enhanced model: size, "download and use" (the mode switches to enhanced once the files
 * are verified, V-7.1), progress, cancel, retry, verify, delete (the model in use is switched
 * back to basic first, V-7.5).
 */
function EnhancedModel({
  model,
  reload,
  enable,
  canEnable,
}: {
  readonly model: SpeechModelView;
  readonly reload: () => void;
  readonly enable: (on: boolean) => Promise<unknown>;
  /** False when managed settings lock the mode. */
  readonly canEnable: boolean;
}) {
  const { t, format } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verify = useVerify(model, reload);
  // Set by "download and use"; the switch happens when the download is verified.
  const requested = useRef(false);
  useEffect(() => {
    if (!requested.current || model.state !== 'ready') return;
    requested.current = false;
    if (canEnable) {
      enable(true).catch((e: unknown) => {
        setError(reason(e));
      });
    }
  }, [model.state, canEnable, enable]);
  const act = (op: 'download' | 'cancel' | 'delete') => {
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
  const absent = model.state === 'missing' || model.state === 'failed' || model.state === 'corrupt';
  const actions = (
    <>
      {absent && (
        <Button
          size="small"
          disabled={busy}
          data-testid="voice-download"
          onClick={() => {
            requested.current = true;
            act('download');
          }}
        >
          {model.state !== 'missing'
            ? t('settings.voice.retry')
            : canEnable
              ? t('settings.voice.downloadEnable')
              : t('settings.voice.download')}
        </Button>
      )}
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
      {model.state === 'ready' && verify.button}
      {model.state === 'ready' && (
        <Button
          variant="destructive"
          size="small"
          disabled={busy || (model.active && !canEnable)}
          data-testid="voice-model-delete"
          onClick={() => {
            if (!model.active) {
              act('delete');
              return;
            }
            // In use: back to basic first, then Core frees the refiner and deletes.
            enable(false)
              .then(() => {
                act('delete');
              })
              .catch((e: unknown) => {
                setError(reason(e));
              });
          }}
        >
          {t('settings.voice.delete')}
        </Button>
      )}
    </>
  );
  return (
    <ModelRow
      kind="enhanced"
      name={t('settings.voice.modelEnhanced')}
      state={model.state}
      stateText={
        model.state === 'downloading'
          ? t('settings.voice.downloading', { percent: format.number(percent) })
          : t(STATE_TEXT[model.state])
      }
      description={t('settings.voice.modelEnhancedHint', {
        size: megabytes(format, model.downloadBytes),
      })}
      actions={actions}
    >
      {downloading && (
        <progress
          className="voice-progress"
          max={100}
          value={percent}
          aria-label={t('settings.voice.downloadProgress')}
          data-testid="voice-download-progress"
        />
      )}
      {model.state === 'failed' && model.error !== undefined && (
        <span className="preference-description">{t('settings.voice.downloadFailed')}</span>
      )}
      {model.active && (
        <span className="preference-description">{t('settings.voice.deleteActive')}</span>
      )}
      {verify.result}
      {error !== '' && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </ModelRow>
  );
}
