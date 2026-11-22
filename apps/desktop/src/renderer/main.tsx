import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { EVENT_PROBE_HASH } from '../shared/event-probe.js';
import { TERMINAL_LAB_HASH } from '../shared/terminal-lab.js';
import { TRANSCRIPT_LAB_HASH } from '../shared/transcript-lab.js';
import { AppProvider } from './app/app-context.js';
import { registerBuiltInSettingsPages } from './settings/pages.js';
import { SettingsApp } from './settings/SettingsApp.js';
import { Shell } from './shell/Shell.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}
const root = createRoot(container);
const hash = window.location.hash;

/** `#/settings` is the settings window; everything else is the main window. */
function renderApp(target: Root): void {
  // The app's own stylesheet rules apply from the first paint (app.css), not to the test pages.
  document.documentElement.dataset.app = 'piarc';
  const settings = hash.startsWith('#/settings');
  if (settings) {
    registerBuiltInSettingsPages();
  }
  void window.piarc.getAppState().then((state) => {
    target.render(
      <StrictMode>
        <AppProvider initial={state}>{settings ? <SettingsApp /> : <Shell />}</AppProvider>
      </StrictMode>,
    );
  });
}

// The test pages exist outside the release flavor only: the bundler drops this branch and the
// chunk with the pages when `__PIARC_RELEASE_BUILD__` is true (T45, I13, I24, I30). The app's
// own windows render at once, without waiting for that chunk.
const TEST_PAGES = [EVENT_PROBE_HASH, TRANSCRIPT_LAB_HASH, TERMINAL_LAB_HASH];
if (!__PIARC_RELEASE_BUILD__ && TEST_PAGES.some((page) => hash.startsWith(page))) {
  void import('./test-pages.js').then(({ renderTestPage }) => {
    if (!renderTestPage(root, hash)) renderApp(root);
  });
} else {
  renderApp(root);
}
