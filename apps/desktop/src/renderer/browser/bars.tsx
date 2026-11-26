// The strips around the page (B1.3, B1.4): what the page asks the user, the find bar, the
// device toolbar and downloads. They are DOM in the panel; the page's view gives up the space
// they take, so nothing is drawn under the native view.
import { useEffect, useRef, useState } from 'react';

import {
  DEVICE_PRESETS,
  EMULATION_LIMITS,
  type BrowserDownload,
  type BrowserEmulation,
  type BrowserFind,
  type BrowserMedia,
  type BrowserPrompt,
  type BrowserControl,
  type BrowserSpaceState,
  type DevicePresetId,
} from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useApp, useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { CaretDownGlyph, CaretUpGlyph, CloseIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';

const PERMISSIONS: Readonly<Record<string, MessageId>> = {
  media: 'browser.permission.media',
  geolocation: 'browser.permission.geolocation',
  notifications: 'browser.permission.notifications',
  'clipboard-read': 'browser.permission.clipboard-read',
  midi: 'browser.permission.midi',
  midiSysex: 'browser.permission.midiSysex',
  pointerLock: 'browser.permission.pointerLock',
  keyboardLock: 'browser.permission.keyboardLock',
  'local-fonts': 'browser.permission.local-fonts',
  'idle-detection': 'browser.permission.idle-detection',
  'window-management': 'browser.permission.window-management',
  'storage-access': 'browser.permission.storage-access',
  'top-level-storage-access': 'browser.permission.top-level-storage-access',
};

export type Answer = (
  prompt: string,
  accept: boolean,
  fields?: { text?: string; user?: string; password?: string },
) => void;

export function PromptBar({
  prompt,
  answer,
}: {
  readonly prompt: BrowserPrompt;
  readonly answer: Answer;
}) {
  const t = useT();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  switch (prompt.kind) {
    case 'permission': {
      const key = PERMISSIONS[prompt.permission];
      const permission =
        key === undefined
          ? t('browser.permission.other', { permission: prompt.permission })
          : t(key);
      return (
        <div className="browser-prompt" role="alertdialog" data-testid="browser-permission">
          <span className="browser-prompt-text">
            {t('browser.permission.ask', { origin: revealBidi(prompt.origin), permission })}
          </span>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              answer(prompt.id, false);
            }}
          >
            {t('browser.permission.deny')}
          </Button>
          <Button
            size="small"
            variant="primary"
            onClick={() => {
              answer(prompt.id, true);
            }}
          >
            {t('browser.permission.allow')}
          </Button>
        </div>
      );
    }
    case 'auth':
      return (
        <form
          className="browser-prompt browser-auth"
          role="alertdialog"
          data-testid="browser-auth"
          onSubmit={(event) => {
            event.preventDefault();
            answer(prompt.id, true, { user, password });
          }}
        >
          <span className="browser-prompt-text">
            {t(prompt.proxy ? 'browser.auth.proxy' : 'browser.auth.title', {
              host: revealBidi(prompt.host),
            })}
            {prompt.realm !== '' && (
              <span className="browser-prompt-detail">
                {t('browser.auth.realm', { realm: revealBidi(prompt.realm) })}
              </span>
            )}
          </span>
          <input
            className="browser-field"
            aria-label={t('browser.auth.user')}
            placeholder={t('browser.auth.user')}
            autoComplete="off"
            value={user}
            onChange={(event) => {
              setUser(event.target.value);
            }}
          />
          <input
            className="browser-field"
            type="password"
            aria-label={t('browser.auth.password')}
            placeholder={t('browser.auth.password')}
            autoComplete="off"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <Button
            size="small"
            variant="ghost"
            type="button"
            onClick={() => {
              answer(prompt.id, false);
            }}
          >
            {t('browser.auth.cancel')}
          </Button>
          <Button size="small" variant="primary" type="submit">
            {t('browser.auth.signIn')}
          </Button>
        </form>
      );
    case 'certificate':
      return (
        <div className="browser-prompt browser-cert" role="alertdialog" data-testid="browser-cert">
          <span className="browser-prompt-text">
            {t('browser.cert.title', { host: revealBidi(prompt.host) })}
            <span className="browser-prompt-detail">
              {t('browser.cert.detail', { error: prompt.error, fingerprint: prompt.fingerprint })}
            </span>
            {!prompt.bypassable && (
              <span className="browser-prompt-detail">{t('browser.cert.notBypassable')}</span>
            )}
          </span>
          <Button
            size="small"
            variant="primary"
            onClick={() => {
              answer(prompt.id, false);
            }}
          >
            {t('browser.cert.back')}
          </Button>
          {prompt.bypassable && (
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                answer(prompt.id, true);
              }}
            >
              {t('browser.cert.proceed')}
            </Button>
          )}
        </div>
      );
    case 'dialog':
      return null;
  }
}

export function FindBar({
  find,
  onFind,
  onClose,
}: {
  readonly find: BrowserFind | undefined;
  readonly onFind: (text: string, forward: boolean, next: boolean) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find?.text ?? '');
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const count =
    find === undefined || text === ''
      ? ''
      : find.matches === 0
        ? t('browser.find.none')
        : t('browser.find.count', { active: find.active, matches: find.matches });
  return (
    <div className="browser-find" role="search" data-testid="browser-find">
      <input
        ref={input}
        className="browser-field"
        aria-label={t('browser.find')}
        placeholder={t('browser.find')}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onFind(event.target.value, true, false);
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onFind(text, !event.shiftKey, true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="browser-find-count" aria-live="polite">
        {count}
      </span>
      <IconButton
        size="xs"
        label={t('browser.find.previous')}
        onClick={() => {
          onFind(text, false, true);
        }}
      >
        <CaretUpGlyph />
      </IconButton>
      <IconButton
        size="xs"
        label={t('browser.find.next')}
        onClick={() => {
          onFind(text, true, true);
        }}
      >
        <CaretDownGlyph />
      </IconButton>
      <IconButton size="xs" label={t('browser.find.close')} onClick={onClose}>
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
}

type Emulation = Omit<BrowserEmulation, 'by'>;

function presetOf(emulation: BrowserEmulation | null): DevicePresetId | 'responsive' | 'custom' {
  if (emulation === null) return 'responsive';
  const preset = DEVICE_PRESETS.find(
    (p) =>
      (p.width === emulation.width && p.height === emulation.height) ||
      (p.width === emulation.height && p.height === emulation.width),
  );
  return preset?.id ?? 'custom';
}

function clamp(value: number): number {
  return Math.min(EMULATION_LIMITS.max, Math.max(EMULATION_LIMITS.min, Math.round(value)));
}

export function DeviceBar({
  emulation,
  media,
  onEmulate,
  onMedia,
}: {
  readonly emulation: BrowserEmulation | null;
  readonly media: BrowserMedia;
  readonly onEmulate: (emulation: Emulation | null) => void;
  readonly onMedia: (media: BrowserMedia) => void;
}) {
  const t = useT();
  const preset = presetOf(emulation);
  const current: Emulation = emulation ?? {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
  };
  const size = (field: 'width' | 'height', value: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    onEmulate({ ...current, [field]: clamp(number) });
  };
  return (
    <div
      className="browser-device"
      role="toolbar"
      aria-label={t('browser.device')}
      data-testid="browser-device"
    >
      <select
        className="browser-field"
        aria-label={t('browser.device.preset')}
        value={preset}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'responsive') {
            onEmulate(null);
            return;
          }
          const chosen = DEVICE_PRESETS.find((p) => p.id === value);
          if (chosen !== undefined) {
            onEmulate({
              width: chosen.width,
              height: chosen.height,
              deviceScaleFactor: chosen.deviceScaleFactor,
              mobile: chosen.mobile,
              touch: chosen.touch,
            });
          }
        }}
      >
        <option value="responsive">{t('browser.device.responsive')}</option>
        {DEVICE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {t(`browser.device.preset.${p.id}`)}
          </option>
        ))}
        {preset === 'custom' && <option value="custom">{t('browser.device.preset.custom')}</option>}
      </select>
      {emulation !== null && (
        <>
          <input
            className="browser-field browser-number"
            type="number"
            aria-label={t('browser.device.width')}
            min={EMULATION_LIMITS.min}
            max={EMULATION_LIMITS.max}
            value={emulation.width}
            onChange={(event) => {
              size('width', event.target.value);
            }}
          />
          <span aria-hidden="true">×</span>
          <input
            className="browser-field browser-number"
            type="number"
            aria-label={t('browser.device.height')}
            min={EMULATION_LIMITS.min}
            max={EMULATION_LIMITS.max}
            value={emulation.height}
            onChange={(event) => {
              size('height', event.target.value);
            }}
          />
          <select
            className="browser-field"
            aria-label={t('browser.device.scale')}
            value={String(emulation.deviceScaleFactor)}
            onChange={(event) => {
              onEmulate({ ...current, deviceScaleFactor: Number(event.target.value) });
            }}
          >
            {[1, 2, 2.625, 3].map((ratio) => (
              <option key={ratio} value={String(ratio)}>
                {`${String(ratio)}×`}
              </option>
            ))}
          </select>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              onEmulate({ ...current, width: current.height, height: current.width });
            }}
          >
            {t('browser.device.rotate')}
          </Button>
          <label className="browser-check">
            <input
              type="checkbox"
              checked={emulation.touch}
              onChange={(event) => {
                onEmulate({
                  ...current,
                  touch: event.target.checked,
                  mobile: event.target.checked,
                });
              }}
            />
            {t('browser.device.touch')}
          </label>
          {emulation.by === 'agent' && (
            <span className="browser-badge" data-testid="browser-device-agent">
              {t('browser.device.byAgent')}
            </span>
          )}
        </>
      )}
      <select
        className="browser-field"
        aria-label={t('browser.device.scheme')}
        value={media.colorScheme}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'system' || value === 'light' || value === 'dark') {
            onMedia({ ...media, colorScheme: value });
          }
        }}
      >
        <option value="system">{t('browser.device.scheme.system')}</option>
        <option value="light">{t('browser.device.scheme.light')}</option>
        <option value="dark">{t('browser.device.scheme.dark')}</option>
      </select>
      <label className="browser-check">
        <input
          type="checkbox"
          checked={media.reducedMotion}
          onChange={(event) => {
            onMedia({ ...media, reducedMotion: event.target.checked });
          }}
        />
        {t('browser.device.reducedMotion')}
      </label>
    </div>
  );
}

const DOWNLOAD_STATES: Readonly<Record<BrowserDownload['state'], MessageId>> = {
  progressing: 'browser.download.progressing',
  completed: 'browser.download.completed',
  cancelled: 'browser.download.cancelled',
  interrupted: 'browser.download.interrupted',
};

export function Downloads({
  downloads,
  onAction,
}: {
  readonly downloads: readonly BrowserDownload[];
  readonly onAction: (id: string, action: 'cancel' | 'show') => void;
}) {
  const t = useT();
  const { format } = useApp();
  if (downloads.length === 0) return null;
  return (
    <ul
      className="browser-downloads"
      aria-label={t('browser.downloads')}
      data-testid="browser-downloads"
    >
      {downloads.slice(-3).map((download) => (
        <li key={download.id} className="browser-download" data-state={download.state}>
          <span className="browser-download-name">{revealBidi(download.name)}</span>
          <span className="browser-download-state">
            {download.state === 'progressing' && download.total > 0
              ? format.number(download.received / download.total, { style: 'percent' })
              : t(DOWNLOAD_STATES[download.state])}
          </span>
          {download.state === 'progressing' && (
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                onAction(download.id, 'cancel');
              }}
            >
              {t('browser.download.cancel')}
            </Button>
          )}
          {download.state === 'completed' && (
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                onAction(download.id, 'show');
              }}
            >
              {t('browser.download.show')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent's control bar (B2.5): while the agent works in the shown Space the user can take
 * it over or stop the call; after a hand-off the user hands it back when done.
 */
export function AgentBar({
  space,
  tainted,
  onControl,
  onReload,
}: {
  readonly space: BrowserSpaceState;
  /** The shown page ran the agent's script (B2.5.4). */
  readonly tainted: boolean;
  readonly onControl: (action: BrowserControl) => void;
  readonly onReload: () => void;
}) {
  const t = useT();
  // An agent Space between calls needs no bar; one the user holds always shows it.
  if (space.kind !== 'agent' || space.ownership === 'user') return null;
  if (space.ownership === 'agent' && !space.running) return null;
  if (space.ownership === 'agentDelegatedToUser') {
    return (
      <div className="browser-agent is-user" role="status" data-testid="browser-agent-bar">
        <span className="browser-prompt-text">
          {space.handOff === undefined
            ? t('browser.agent.inControl')
            : t('browser.agent.asks', { reason: revealBidi(space.handOff) })}
          <span className="browser-prompt-detail">
            {t('browser.agent.space', { name: revealBidi(space.name) })}
          </span>
          {tainted && (
            <span className="browser-prompt-detail" data-testid="browser-tainted">
              {t('browser.agent.tainted')}
            </span>
          )}
        </span>
        {tainted && (
          <Button size="small" variant="ghost" onClick={onReload}>
            {t('browser.agent.reload')}
          </Button>
        )}
        <Button
          size="small"
          variant="primary"
          data-testid="browser-hand-back"
          onClick={() => {
            onControl('handBack');
          }}
        >
          {space.handOff === undefined ? t('browser.agent.handBack') : t('browser.agent.done')}
        </Button>
      </div>
    );
  }
  return (
    <div className="browser-agent" role="status" data-testid="browser-agent-bar">
      <span className="browser-prompt-text">
        {space.action === undefined
          ? t('browser.agent.running')
          : t('browser.agent.runningAction', { action: revealBidi(space.action) })}
        <span className="browser-prompt-detail">{t('browser.agent.locked')}</span>
      </span>
      <Button
        size="small"
        variant="ghost"
        data-testid="browser-stop"
        disabled={!space.running}
        onClick={() => {
          onControl('stop');
        }}
      >
        {t('browser.agent.stop')}
      </Button>
      <Button
        size="small"
        data-testid="browser-takeover"
        onClick={() => {
          onControl('takeOver');
        }}
      >
        {t('browser.agent.takeOver')}
      </Button>
    </div>
  );
}
