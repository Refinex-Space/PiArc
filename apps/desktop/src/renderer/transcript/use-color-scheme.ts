// Whether highlighted code takes its dark token colors: the app's theme choice, and the system
// color scheme when the choice is "system" (I186: following the system alone put light colors on
// the dark theme's backgrounds).
import { useSyncExternalStore } from 'react';

import { useApp } from '../app/app-context.js';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

export function useDarkScheme(): boolean {
  const theme = useApp().preferences.appearance.theme;
  const systemDark = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
  return theme === 'system' ? systemDark : theme === 'dark';
}
