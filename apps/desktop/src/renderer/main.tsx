import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { EVENT_PROBE_HASH } from '../shared/event-probe.js';
import { TERMINAL_LAB_HASH } from '../shared/terminal-lab.js';
import { TRANSCRIPT_LAB_HASH } from '../shared/transcript-lab.js';
import { AppProvider } from './app/app-context.js';
import { TranscriptLab } from './lab/TranscriptLab.js';
import { EventProbe, installEventProbe } from './probe/EventProbe.js';
import { registerBuiltInSettingsPages } from './settings/pages.js';
import { SettingsApp } from './settings/SettingsApp.js';
import { Shell } from './shell/Shell.js';
import { TerminalLab } from './terminal/TerminalLab.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}
const root = createRoot(container);
// Test pages: the event probe (T04), the transcript prototype (T09) and the terminal
// prototype (T10). `#/settings` is the settings window; everything else is the main window.
const hash = window.location.hash;
if (hash.startsWith(EVENT_PROBE_HASH)) {
  installEventProbe();
  root.render(
    <StrictMode>
      <EventProbe />
    </StrictMode>,
  );
} else if (hash.startsWith(TRANSCRIPT_LAB_HASH)) {
  root.render(
    <StrictMode>
      <TranscriptLab />
    </StrictMode>,
  );
} else if (hash.startsWith(TERMINAL_LAB_HASH)) {
  root.render(
    <StrictMode>
      <TerminalLab />
    </StrictMode>,
  );
} else {
  // The app's own stylesheet rules apply from the first paint (app.css), not to the test pages.
  document.documentElement.dataset.app = 'piarc';
  const settings = hash.startsWith('#/settings');
  if (settings) {
    registerBuiltInSettingsPages();
  }
  void window.piarc.getAppState().then((state) => {
    root.render(
      <StrictMode>
        <AppProvider initial={state}>{settings ? <SettingsApp /> : <Shell />}</AppProvider>
      </StrictMode>,
    );
  });
}
