// The terminal prototype page (`#/terminal-lab`, T10): one terminal drawn from Core's frames,
// a toolbar to hide it and read the frame counters, and `window.__piarcTerminalLab` for L4
// tests and the S7 benchmark. It starts nothing itself (T34: `window.piarc` has no way to
// start a terminal without a session): tests create a terminal through the main-process test
// hooks (development builds of Core only) and `attach` it.
import { useEffect, useRef, useState } from 'react';

import type { TerminalLabApi, TerminalLabStats } from '../../shared/terminal-lab.js';
import { TerminalController } from './controller.js';

export function TerminalLab() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [title, setTitle] = useState('');
  const [stats, setStats] = useState<TerminalLabStats | null>(null);
  const [exited, setExited] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const controller = new TerminalController(host, window.piarc, {
      platform: navigator.userAgent.includes('Mac') ? 'mac' : 'other',
      isGlobalKey: () => false,
      label: 'Terminal input',
      fit: false,
    });
    let subscribed: number | null = null;
    let echo: Promise<number> | undefined;
    const attach = (id: number) => {
      controller.attach(id);
      if (subscribed !== null) {
        void window.piarc.unsubscribeEvents(`term/${String(subscribed)}`);
      }
      subscribed = id;
      setExited(null);
      void window.piarc.subscribeEvents(`term/${String(id)}`, (batch) => {
        const events: unknown = JSON.parse(new TextDecoder().decode(batch.payload));
        for (const event of Array.isArray(events) ? (events as unknown[]) : []) {
          if (typeof event !== 'object' || event === null || !('type' in event)) {
            continue;
          }
          if (event.type === 'output') {
            controller.wake();
          } else if (
            event.type === 'title' &&
            'title' in event &&
            typeof event.title === 'string'
          ) {
            setTitle(event.title);
          } else if (event.type === 'exited' && 'code' in event) {
            setExited(`exited with ${String(event.code)}`);
          }
        }
      });
    };
    const api: TerminalLabApi = {
      attach,
      terminalId: () => controller.terminalId,
      setHidden,
      stats: () => controller.stats(),
      resetStats: () => {
        controller.resetStats();
      },
      screenText: () => controller.screen.plainText(),
      cursorCell: () => ({ x: controller.screen.cursor.x, y: controller.screen.cursor.y }),
      cursorRect: () => controller.cursorRect(),
      textareaRect: () => controller.textareaRect(),
      preedit: () => controller.preedit,
      focus: () => {
        controller.focus();
      },
      resize: (cols, rows) => {
        controller.resize(cols, rows);
      },
      armEcho: (char) => {
        echo = controller.armEcho(char);
      },
      echoResult: () => echo ?? Promise.reject(new Error('armEcho was not called')),
    };
    globalThis.__piarcTerminalLab = api;
    controller.focus();
    const timer = window.setInterval(() => {
      setStats(controller.stats());
    }, 500);
    return () => {
      window.clearInterval(timer);
      globalThis.__piarcTerminalLab = undefined;
      controller.dispose();
    };
  }, []);

  return (
    <div className="terminal-lab" data-testid="terminal-lab">
      <header className="terminal-lab-toolbar">
        <button
          type="button"
          data-testid="terminal-toggle"
          onClick={() => {
            setHidden((value) => !value);
          }}
        >
          {hidden ? 'Show terminal' : 'Hide terminal'}
        </button>
        <span data-testid="terminal-title">{title}</span>
        <span data-testid="terminal-exit">{exited ?? ''}</span>
        <span className="terminal-lab-stats" data-testid="terminal-stats">
          {stats === null
            ? ''
            : `frames ${String(stats.framesReceived)} (empty ${String(stats.emptyFrames)}) · ` +
              `${String(Math.round(stats.bytes / 1024))} KiB`}
        </span>
      </header>
      <div
        ref={hostRef}
        className="terminal-lab-host"
        data-testid="terminal-host"
        style={{ display: hidden ? 'none' : 'block' }}
      />
    </div>
  );
}
