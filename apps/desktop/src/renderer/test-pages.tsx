// The test pages (T04's event probe, T09's transcript prototype, T10's terminal prototype) for
// L4 and the benchmarks. main.tsx loads this module only outside the release flavor, so the
// release build's renderer does not carry them (T45, I13, I24, I30).
import { StrictMode } from 'react';
import type { Root } from 'react-dom/client';

import { EVENT_PROBE_HASH } from '../shared/event-probe.js';
import { TERMINAL_LAB_HASH } from '../shared/terminal-lab.js';
import { TRANSCRIPT_LAB_HASH } from '../shared/transcript-lab.js';
import { AppProvider } from './app/app-context.js';
import { TranscriptLab } from './lab/TranscriptLab.js';
import { EventProbe, installEventProbe } from './probe/EventProbe.js';
import { TerminalLab } from './terminal/TerminalLab.js';

/** Renders the test page `hash` names into `root`; false when it names none. */
export function renderTestPage(root: Root, hash: string): boolean {
  if (hash.startsWith(EVENT_PROBE_HASH)) {
    installEventProbe();
    root.render(
      <StrictMode>
        <EventProbe />
      </StrictMode>,
    );
    return true;
  }
  if (hash.startsWith(TRANSCRIPT_LAB_HASH)) {
    // The prototype page shares the app's transcript rows, which read the translator: English,
    // whatever the system language, so the page's tests find the same labels everywhere.
    void window.piarc.getAppState().then((state) => {
      root.render(
        <StrictMode>
          <AppProvider
            initial={{
              ...state,
              preferences: { ...state.preferences, language: 'en' },
              locale: 'en',
            }}
          >
            <TranscriptLab />
          </AppProvider>
        </StrictMode>,
      );
    });
    return true;
  }
  if (hash.startsWith(TERMINAL_LAB_HASH)) {
    root.render(
      <StrictMode>
        <TerminalLab />
      </StrictMode>,
    );
    return true;
  }
  return false;
}
