// The agent's first use of the browser in a session (design addendum B2.5.5, setting
// `browser.revealOnAgentUse`, B5.5): the preview opens when that session is on screen and the
// setting is on; otherwise its tool button gets the dot. Once per session for the window's life.
import { useEffect, useRef } from 'react';

import { useApp } from '../app/app-context.js';
import { showPanel } from '../shell/registry.js';
import { useUi } from '../shell/ui.js';
import { markPreview } from './attention.js';

export function AgentReveal() {
  const reveal = useApp().preferences.browser.revealOnAgentUse;
  const { view } = useUi();
  const latest = useRef({ reveal, shown: view.kind === 'session' ? view.id : undefined });
  useEffect(() => {
    latest.current = { reveal, shown: view.kind === 'session' ? view.id : undefined };
  }, [reveal, view]);
  useEffect(() => {
    const used = new Set<string>();
    return window.piarc.onAppEvent((event) => {
      if (event.type !== 'browser' || used.has(event.sessionId)) return;
      if (!event.state.spaces.some((space) => space.kind === 'agent' && space.running)) return;
      used.add(event.sessionId);
      if (latest.current.reveal && latest.current.shown === event.sessionId) showPanel('preview');
      else markPreview(event.sessionId);
    });
  }, []);
  return null;
}
