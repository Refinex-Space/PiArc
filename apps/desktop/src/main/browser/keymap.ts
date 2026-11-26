// Keys the preview takes while the page has focus (B1.3.9, C3, design addendum section 4.7).
// The guest's `before-input-event` prevents them, so neither the page nor the app menu sees
// them, and the panel runs the command. `Mod+W` closes a tab, never the session.

/** The subset of Electron's `Input` this map reads. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const PREVIEW_KEYS = [
  'address',
  'reload',
  'hardReload',
  'back',
  'forward',
  'newTab',
  'closeTab',
  'reopenTab',
  'nextTab',
  'previousTab',
  'lastTab',
  'tab1',
  'tab2',
  'tab3',
  'tab4',
  'tab5',
  'tab6',
  'tab7',
  'tab8',
  'find',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'devtools',
  'pick',
  'annotate',
  'device',
  'leave',
] as const;

export type PreviewKey = (typeof PREVIEW_KEYS)[number];

export function isPreviewKey(value: unknown): value is PreviewKey {
  return typeof value === 'string' && (PREVIEW_KEYS as readonly string[]).includes(value);
}

/** The preview command of a key press, or `undefined` when the page should get it. */
export function previewKey(input: KeyInput, platform: string): PreviewKey | undefined {
  if (input.type !== 'keyDown') return undefined;
  const mac = platform === 'darwin';
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  const key = input.key.toLowerCase();
  if (input.key === 'F12') return 'devtools';
  if (input.key === 'F6') return 'leave';
  if (input.key === 'F5') return input.shift ? 'hardReload' : 'reload';
  if (input.control && input.key === 'Tab') return input.shift ? 'previousTab' : 'nextTab';
  if (!mac && input.alt && !input.control && !input.meta) {
    if (input.key === 'ArrowLeft') return 'back';
    if (input.key === 'ArrowRight') return 'forward';
  }
  if (!mod) return undefined;
  if (input.alt) return input.code === 'KeyI' ? 'devtools' : undefined;
  if (input.shift) {
    switch (input.code) {
      case 'KeyR':
        return 'hardReload';
      case 'KeyT':
        return 'reopenTab';
      case 'KeyS':
        return 'pick';
      case 'KeyX':
        return 'annotate';
      case 'KeyM':
        return 'device';
      case 'Equal':
        return 'zoomIn';
      default:
        return undefined;
    }
  }
  if (/^[1-8]$/.test(key)) return `tab${key}` as PreviewKey;
  switch (input.code) {
    case 'KeyL':
      return 'address';
    case 'KeyR':
      return 'reload';
    case 'KeyT':
      return 'newTab';
    case 'KeyW':
      return 'closeTab';
    case 'KeyF':
      return 'find';
    case 'Digit9':
      return 'lastTab';
    case 'BracketLeft':
      return 'back';
    case 'BracketRight':
      return 'forward';
    case 'Equal':
      return 'zoomIn';
    case 'Minus':
      return 'zoomOut';
    case 'Digit0':
      return 'zoomReset';
    default:
      return undefined;
  }
}
