import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { EVENT_PROBE_HASH } from '../shared/event-probe.js';
import { App } from './App.js';
import { EventProbe, installEventProbe } from './probe/EventProbe.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}
// The event probe is a test page (T04); everything else gets the app shell.
const probe = window.location.hash.startsWith(EVENT_PROBE_HASH);
if (probe) {
  installEventProbe();
}
createRoot(container).render(<StrictMode>{probe ? <EventProbe /> : <App />}</StrictMode>);
