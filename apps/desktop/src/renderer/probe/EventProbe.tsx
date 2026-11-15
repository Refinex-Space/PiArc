// The event probe page (`#/event-probe`): a test page for the Core event channel (T04, S2).
// L4 tests and the benchmark drive it through `window.__piarcEventProbe`; the page shows
// the counters for screenshots.
import { useEffect, useState } from 'react';

import type { EventProbeApi, ProbeSnapshot } from '../../shared/event-probe.js';
import { ProbeCounter } from './probe-counter.js';

declare global {
  interface Window {
    __piarcEventProbe?: EventProbeApi;
  }
}

const counter = new ProbeCounter();

/** Installs `window.__piarcEventProbe`. Called once, when the probe page is chosen. */
export function installEventProbe(): void {
  window.__piarcEventProbe = {
    subscribe: async (routes) => {
      for (const route of routes) {
        await window.piarc.subscribeEvents(route, (batch) => {
          counter.record(batch);
        });
      }
    },
    unsubscribe: (route) => window.piarc.unsubscribeEvents(route),
    snapshot: () => counter.snapshot(),
    reset: () => {
      counter.reset();
    },
  };
}

const REFRESH_MS = 250;

export function EventProbe() {
  const [snapshot, setSnapshot] = useState<ProbeSnapshot>(() => counter.snapshot());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSnapshot(counter.snapshot());
    }, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const routes = Object.entries(snapshot.routes);
  return (
    <main className="probe" data-testid="event-probe" aria-label="Event probe">
      <h1 className="shell-heading">Event probe</h1>
      {routes.length === 0 ? (
        <p className="shell-placeholder">No events yet</p>
      ) : (
        <table className="probe-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <th scope="col">Batches</th>
              <th scope="col">Events</th>
              <th scope="col">Bytes</th>
              <th scope="col">Order errors</th>
            </tr>
          </thead>
          <tbody>
            {routes.map(([route, stats]) => (
              <tr key={route} data-testid={`probe-route-${route}`}>
                <td>{route}</td>
                <td>{stats.batches}</td>
                <td>{stats.events}</td>
                <td>{stats.bytes}</td>
                <td>{stats.batchSeqErrors + stats.eventSeqErrors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
