// The accent on the Appearance page (ADR-0104): a menu of swatches (the presets from
// design/tokens/accents.json, then "Custom"). A custom accent adds the system color picker and
// a `#rrggbb` field; the color is saved once it is valid and corrected for contrast where it is
// applied (`app/accent.ts`), so what the user typed stays what they typed.
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

import { ACCENTS, ACCENT_SWATCHES, DEFAULT_ACCENT } from '../../shared/design-tokens.js';
import type { MessageId } from '../../shared/i18n/index.js';
import {
  isAccentColor,
  type AccentPreference,
  type PreferenceChange,
} from '../../shared/preferences.js';
import { useApp } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { MenuPopup, useMenu } from '../shell/Menu.js';
import { ChevronDownIcon, StyleIcon } from '../shell/icons.js';
import { SettingsRow } from './layout.js';
import { ManagedBadge, useIsManaged } from './managed.js';

/** Waits this long after the picker last moved before saving (it reports every step). */
const PICKER_SAVE_DELAY_MS = 250;

function Swatch({ light, dark }: { readonly light: string; readonly dark: string }) {
  return (
    <span
      className="accent-swatch"
      aria-hidden="true"
      style={{ '--swatch-light': light, '--swatch-dark': dark } as CSSProperties}
    />
  );
}

function swatchOf(accent: AccentPreference, color: string) {
  if (accent === 'custom') {
    return isAccentColor(color) ? <Swatch light={color} dark={color} /> : <StyleIcon />;
  }
  return <Swatch {...ACCENT_SWATCHES[accent]} />;
}

const LABELS: Readonly<Record<AccentPreference, MessageId>> = {
  graphite: 'settings.accent.default',
  blue: 'settings.accent.blue',
  green: 'settings.accent.green',
  yellow: 'settings.accent.yellow',
  pink: 'settings.accent.pink',
  orange: 'settings.accent.orange',
  purple: 'settings.accent.purple',
  custom: 'settings.accent.custom',
};

function labelOf(accent: AccentPreference): MessageId {
  return LABELS[accent];
}

export function AccentRow({ save }: { readonly save: (change: PreferenceChange) => void }) {
  const { t, preferences } = useApp();
  const { accent, accentColor } = preferences.appearance;
  const managed = useIsManaged('/appearance/accent');
  const managedColor = useIsManaged('/appearance/accentColor');
  const menu = useMenu();
  const labelId = useId();
  const hintId = useId();
  const [text, setText] = useState(accentColor);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setText(accentColor);
  }, [accentColor]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );
  const saveColor = (value: string) => {
    if (isAccentColor(value) && value.toLowerCase() !== accentColor) {
      save({ key: 'appearance.accentColor', value: value.toLowerCase() });
    }
  };
  const choose = (next: AccentPreference) => {
    // The first custom color starts from the accent in use, so nothing jumps.
    if (next === 'custom' && !isAccentColor(accentColor)) {
      const from = accent === 'custom' ? DEFAULT_ACCENT : accent;
      save({ key: 'appearance.accentColor', value: ACCENT_SWATCHES[from].light });
    }
    save({ key: 'appearance.accent', value: next });
  };
  const options: readonly AccentPreference[] = [...ACCENTS, 'custom'];
  const valid = isAccentColor(text);
  return (
    <SettingsRow
      testId="setting-accent"
      label={t('settings.accent')}
      labelId={labelId}
      description={t('settings.accent.hint')}
      descriptionId={hintId}
      badge={(managed || managedColor) && <ManagedBadge testId="managed-accent" />}
    >
      <div className="accent-control">
        {accent === 'custom' && (
          <>
            <label className="accent-picker" data-tooltip={t('settings.accent.pick')}>
              <input
                type="color"
                className="accent-picker-input"
                data-focus-proxy
                value={valid ? text.toLowerCase() : ACCENT_SWATCHES[DEFAULT_ACCENT].light}
                disabled={managedColor}
                aria-label={t('settings.accent.pick')}
                data-testid="accent-color-picker"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setText(value);
                  window.clearTimeout(timer.current);
                  timer.current = window.setTimeout(() => {
                    saveColor(value);
                  }, PICKER_SAVE_DELAY_MS);
                }}
              />
              {swatchOf('custom', valid ? text : accentColor)}
            </label>
            <input
              className="input accent-hex"
              value={text}
              disabled={managedColor}
              spellCheck={false}
              maxLength={7}
              aria-label={t('settings.accent.hex')}
              aria-invalid={!valid}
              data-testid="accent-color-input"
              onChange={(event) => {
                const value = event.currentTarget.value.trim();
                setText(value);
                saveColor(value);
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event.nativeEvent)) return;
                if (event.key === 'Escape') {
                  setText(accentColor);
                }
              }}
              onBlur={() => {
                if (!isAccentColor(text)) setText(accentColor);
              }}
            />
          </>
        )}
        <button
          type="button"
          className="accent-trigger"
          disabled={managed}
          aria-haspopup="menu"
          aria-expanded={menu.open !== null}
          aria-labelledby={`${labelId} ${labelId}-value`}
          aria-describedby={hintId}
          data-testid="accent-select"
          data-accent={accent}
          onClick={(event) => {
            menu.openBelowEnd(event.currentTarget);
          }}
        >
          {swatchOf(accent, accentColor)}
          <span id={`${labelId}-value`}>{t(labelOf(accent))}</span>
          <ChevronDownIcon />
        </button>
        {menu.open !== null && (
          <MenuPopup
            at={menu.open}
            label={t('settings.accent')}
            onClose={menu.close}
            items={options.map((option) => ({
              id: option,
              testId: `accent-${option}`,
              label: t(labelOf(option)),
              icon: swatchOf(option, accentColor),
              selected: option === accent,
              run: () => {
                choose(option);
              },
            }))}
          />
        )}
      </div>
    </SettingsRow>
  );
}
