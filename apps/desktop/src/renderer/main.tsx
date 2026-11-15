import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { EVENT_PROBE_HASH } from '../shared/event-probe.js';
import { TERMINAL_LAB_HASH } from '../shared/terminal-lab.js';
import { TRANSCRIPT_LAB_HASH } from '../shared/transcript-lab.js';
import { App } from './App.js';
import { TranscriptLab } from './lab/TranscriptLab.js';
import { EventProbe, installEventProbe } from './probe/EventProbe.js';
import { TerminalLab } from './terminal/TerminalLab.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}
// Test pages: the event probe (T04), the transcript prototype (T09) and the terminal
// prototype (T10); everything else gets the app shell.
const hash = window.location.hash;
let page;
if (hash.startsWith(EVENT_PROBE_HASH)) {
  installEventProbe();
  page = <EventProbe />;
} else if (hash.startsWith(TRANSCRIPT_LAB_HASH)) {
  page = <TranscriptLab />;
} else if (hash.startsWith(TERMINAL_LAB_HASH)) {
  page = <TerminalLab />;
} else {
  page = <App />;
}
createRoot(container).render(<StrictMode>{page}</StrictMode>);
