// The preview tool: the built-in browser of a session (ADR-0088, design addendum B1). The main
// process owns the tabs and the page; this panel shows the chrome around the page and the
// strips the page needs, and tells the main process where the page goes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BrowserRequest } from '../../shared/browser.js';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import { MenuPopup, useMenu, type MenuItem } from '../shell/Menu.js';
import { ToolHeaderContent } from '../shell/ToolHeaderSlot.js';
import { useUi } from '../shell/ui.js';
import { AgentBar, DeviceBar, Downloads, FindBar, PromptBar } from './bars.js';
import { NavigationRow, TabStrip, type ChromeActions } from './chrome.js';
import { ConsoleDrawer } from './console.js';
import { browserCall, useBrowserState } from './use-browser.js';
import { useCapture } from './use-capture.js';
import { showPreview } from './attention.js';
import { ServerFailed, StartPage } from './start.js';
import { failureKey, failures, parseSuggestions } from './start-model.js';
import { Viewport } from './Viewport.js';
import { useSession } from '../store/hooks.js';
import { openChromeImport } from './site-import.js';

export function BrowserPanel({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const ui = useUi();
  const menu = useMenu();
  // The session's workspace: the Chrome import goes into its partition (B5.1).
  const workspace = useSession(sessionId)?.workspace;
  const { state, failure } = useBrowserState(sessionId);
  const [findOn, setFindOn] = useState(false);
  const [deviceOn, setDeviceOn] = useState(false);
  const [consoleOn, setConsoleOn] = useState(false);
  const [focusAddress, setFocusAddress] = useState(0);
  const [claim, setClaim] = useState(false);
  /** Failed servers the user closed the card of (B4.5). */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const tab = state?.tabs.find((candidate) => candidate.id === state.activeTab);
  // B1.1.1: the start page takes the address bar's focus when it appears.
  const blank = tab === undefined || tab.url === '';
  useEffect(() => {
    if (blank) setFocusAddress((n) => n + 1);
  }, [blank, tab?.id]);
  // The preview is on screen: its tool button's dot goes (B4.4).
  useEffect(() => showPreview(sessionId), [sessionId]);
  // The Space of the shown tab: an agent's shows its control bar (B2.5).
  const space = state?.spaces.find((candidate) => candidate.id === tab?.space);

  const report = useCallback(
    (error: unknown) => {
      ui.addToast({ sessionId, text: reason(error) });
    },
    [ui, sessionId],
  );
  const call = useCallback(
    (request: BrowserRequest) => {
      browserCall(sessionId, request, report);
    },
    [sessionId, report],
  );
  // Picking, annotating and screenshots (B3).
  const capture = useCapture({ sessionId, state, tab, call, report });
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const actions = useMemo<ChromeActions>(
    () => ({
      newTab: () => {
        call({ op: 'newTab' });
        setFocusAddress((n) => n + 1);
      },
      select: (id) => {
        call({ op: 'selectTab', tab: id });
      },
      close: (id) => {
        call({ op: 'closeTab', tab: id });
      },
      move: (id, index) => {
        call({ op: 'moveTab', tab: id, index });
      },
      tabMenu: (id) => {
        call({ op: 'contextMenu', tab: id });
      },
      navigate: (input, newTab) => {
        call(
          newTab === true
            ? { op: 'navigate', input, newTab: true }
            : tab === undefined
              ? { op: 'navigate', input }
              : { op: 'navigate', tab: tab.id, input },
        );
      },
      suggest: (input) =>
        window.piarc.browser(sessionId, { op: 'suggest', input }).then(parseSuggestions),
      back: () => {
        if (tab !== undefined) call({ op: 'history', tab: tab.id, direction: 'back' });
      },
      forward: () => {
        if (tab !== undefined) call({ op: 'history', tab: tab.id, direction: 'forward' });
      },
      reload: (hard) => {
        if (tab !== undefined) call({ op: 'reload', tab: tab.id, hard });
      },
      stop: () => {
        if (tab !== undefined) call({ op: 'stop', tab: tab.id });
      },
      toggleFind: () => {
        setFindOn((on) => {
          if (on && tab !== undefined) call({ op: 'stopFind', tab: tab.id });
          return !on;
        });
      },
      toggleDevice: () => {
        setDeviceOn((on) => !on);
      },
      devtools: () => {
        if (tab === undefined) return;
        call({
          op: 'devtools',
          tab: tab.id,
          mode: tab.devtools === 'closed' ? 'docked' : 'closed',
        });
      },
      more: (anchor) => {
        const rect = anchor.getBoundingClientRect();
        menu.openAt(rect.left, rect.bottom + 4, anchor);
      },
      pick: () => {
        captureRef.current.pick();
      },
      annotate: () => {
        captureRef.current.annotate();
      },
      screenshot: (anchor) => {
        captureRef.current.screenshot(anchor);
      },
      importSite: (host) => {
        openChromeImport(host, workspace);
      },
    }),
    [call, tab, menu, sessionId, workspace],
  );

  // Keys pressed while the page had focus come back here (main/browser/keymap.ts).
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type !== 'browserKey' || event.sessionId !== sessionId) return;
        const current = event.tab;
        switch (event.key) {
          case 'address':
            setFocusAddress((n) => n + 1);
            break;
          case 'reload':
          case 'hardReload':
            call({ op: 'reload', tab: current, hard: event.key === 'hardReload' });
            break;
          case 'back':
          case 'forward':
            call({ op: 'history', tab: current, direction: event.key });
            break;
          case 'newTab':
            actions.newTab();
            break;
          case 'closeTab':
            call({ op: 'closeTab', tab: current });
            break;
          case 'reopenTab':
            call({ op: 'reopenClosed' });
            break;
          case 'find':
            setFindOn(true);
            break;
          case 'zoomIn':
          case 'zoomOut':
          case 'zoomReset':
            call({
              op: 'zoom',
              tab: current,
              step: event.key === 'zoomIn' ? 'in' : event.key === 'zoomOut' ? 'out' : 'reset',
            });
            break;
          case 'devtools':
            actions.devtools();
            break;
          case 'device':
            setDeviceOn((on) => !on);
            break;
          case 'pick':
            captureRef.current.pick();
            break;
          case 'annotate':
            captureRef.current.annotate();
            break;
          case 'nextTab':
          case 'previousTab':
          case 'lastTab':
          default: {
            const tabs = state?.tabs ?? [];
            const at = tabs.findIndex((candidate) => candidate.id === current);
            let target: number | undefined;
            if (event.key === 'nextTab') target = (at + 1) % tabs.length;
            else if (event.key === 'previousTab') target = (at - 1 + tabs.length) % tabs.length;
            else if (event.key === 'lastTab') target = tabs.length - 1;
            else if (/^tab[1-8]$/.test(event.key)) target = Number(event.key.slice(3)) - 1;
            const chosen = target === undefined ? undefined : tabs[target];
            if (chosen !== undefined) call({ op: 'selectTab', tab: chosen.id });
          }
        }
      }),
    [sessionId, call, actions, state?.tabs],
  );

  useEffect(() => {
    if (state?.shownElsewhere === false) setClaim(false);
  }, [state?.shownElsewhere]);

  if (state === undefined) {
    return failure === undefined ? (
      <div className="browser-panel" data-testid="browser-loading" />
    ) : (
      <div className="browser-panel browser-card" data-testid="browser-unavailable">
        <p>{reason(failure)}</p>
      </div>
    );
  }

  const moreItems: MenuItem[] = [
    {
      id: 'external',
      label: t('browser.openExternal'),
      disabled: tab === undefined || !/^https?:/.test(tab.url),
      run: () => {
        if (tab !== undefined) call({ op: 'openExternal', tab: tab.id });
      },
    },
    {
      id: 'copy',
      label: t('browser.copyUrl'),
      disabled: tab === undefined || tab.url === '',
      run: () => {
        if (tab !== undefined) void navigator.clipboard.writeText(tab.url);
      },
    },
    {
      id: 'zoom-in',
      label: t('browser.zoom.in'),
      disabled: tab === undefined,
      shortcut: 'Mod+=',
      run: () => {
        if (tab !== undefined) call({ op: 'zoom', tab: tab.id, step: 'in' });
      },
    },
    {
      id: 'zoom-out',
      label: t('browser.zoom.out'),
      disabled: tab === undefined,
      shortcut: 'Mod+-',
      run: () => {
        if (tab !== undefined) call({ op: 'zoom', tab: tab.id, step: 'out' });
      },
    },
    {
      id: 'console',
      label: t('browser.console.toggle'),
      disabled: tab === undefined,
      selected: consoleOn,
      testId: 'browser-console-toggle',
      run: () => {
        setConsoleOn((on) => !on);
      },
    },
    {
      id: 'devtools-window',
      label: t('browser.devtools.window'),
      disabled: tab === undefined,
      run: () => {
        if (tab !== undefined) call({ op: 'devtools', tab: tab.id, mode: 'window' });
      },
    },
    {
      id: 'clear',
      label: t('browser.clearData'),
      danger: true,
      run: () => {
        call({ op: 'clearData' });
      },
    },
  ];

  const prompts = state.prompts.filter((prompt) => prompt.tab === tab?.id);
  const pageShown =
    tab !== undefined && !tab.crashed && tab.failure === undefined && tab.url !== '';
  return (
    <div className="browser-panel" data-testid="browser-panel" onKeyDown={capture.onKeyDown}>
      <ToolHeaderContent>
        <TabStrip state={state} actions={actions} />
      </ToolHeaderContent>
      <NavigationRow
        tab={tab}
        actions={actions}
        focusAddress={focusAddress}
        deviceOn={deviceOn}
        findOn={findOn}
        picking={capture.picking}
        annotating={capture.annotating}
      />
      {space !== undefined && (
        <AgentBar
          space={space}
          tainted={tab?.tainted === true}
          onControl={(action) => {
            call({ op: 'control', space: space.id, action });
          }}
          onReload={() => {
            if (tab !== undefined) call({ op: 'reload', tab: tab.id, hard: false });
          }}
        />
      )}
      {prompts.map((prompt) => (
        <PromptBar
          key={prompt.id}
          prompt={prompt}
          answer={(id, accept, fields) => {
            call({ op: 'answer', prompt: id, accept, ...fields });
          }}
        />
      ))}
      {failures(state.services, dismissed).map((server) => (
        <ServerFailed
          key={failureKey(server)}
          sessionId={sessionId}
          server={server}
          call={call}
          onDismiss={() => {
            setDismissed((closed) => new Set([...closed, failureKey(server)]));
          }}
        />
      ))}
      {findOn && tab !== undefined && (
        <FindBar
          find={state.find?.tab === tab.id ? state.find : undefined}
          onFind={(text, forward, next) => {
            call({ op: 'find', tab: tab.id, text, forward, next });
          }}
          onClose={() => {
            setFindOn(false);
            call({ op: 'stopFind', tab: tab.id });
          }}
        />
      )}
      {/* The agent's emulation shows the bar with its badge and Reset (B1.4.2). */}
      {tab !== undefined && (deviceOn || tab.emulation?.by === 'agent') && (
        <DeviceBar
          emulation={tab.emulation}
          media={tab.media}
          onEmulate={(emulation) => {
            call({ op: 'emulate', tab: tab.id, emulation });
          }}
          onMedia={(media) => {
            call({ op: 'media', tab: tab.id, media });
          }}
        />
      )}
      {state.shownElsewhere && !claim ? (
        <div className="browser-card" data-testid="browser-elsewhere">
          <p>{t('browser.elsewhere.title')}</p>
          <Button
            onClick={() => {
              setClaim(true);
            }}
          >
            {t('browser.elsewhere.move')}
          </Button>
        </div>
      ) : (
        <Viewport
          sessionId={sessionId}
          active={pageShown}
          claim={claim}
          frozen={capture.annotating}
          onEnter={() => {
            if (tab !== undefined) call({ op: 'focus', tab: tab.id });
          }}
        >
          {capture.surface}
          {tab === undefined || tab.url === '' ? (
            <StartPage
              sessionId={sessionId}
              services={state.services}
              call={call}
              open={(input) => {
                actions.navigate(input);
              }}
              report={report}
            />
          ) : tab.crashed ? (
            <div className="browser-card" data-testid="browser-crashed">
              <p className="browser-card-title">{t('browser.crashed.title')}</p>
              <Button
                onClick={() => {
                  call({ op: 'reload', tab: tab.id });
                }}
              >
                {t('browser.crashed.reload')}
              </Button>
            </div>
          ) : tab.failure !== undefined ? (
            <div className="browser-card" data-testid="browser-error">
              <p className="browser-card-title">{t('browser.error.title')}</p>
              <p>
                {t('browser.error.detail', {
                  host: hostOf(tab.failure.url),
                  name: tab.failure.name,
                })}
              </p>
              {tab.failure.retry !== undefined && (
                <p role="status" data-testid="browser-error-waiting">
                  {t('browser.error.waiting')}
                </p>
              )}
              <Button
                onClick={() => {
                  call({ op: 'navigate', tab: tab.id, input: tab.failure?.url ?? tab.url });
                }}
              >
                {t('browser.error.retry')}
              </Button>
            </div>
          ) : null}
        </Viewport>
      )}
      {consoleOn && tab !== undefined && (
        <ConsoleDrawer
          sessionId={sessionId}
          tab={tab}
          onClose={() => {
            setConsoleOn(false);
          }}
          onError={report}
          onStatus={(text) => {
            ui.addToast({ sessionId, text });
          }}
        />
      )}
      {capture.strips}
      <Downloads
        downloads={state.downloads}
        onAction={(id, action) => {
          call({ op: 'download', download: id, action });
        }}
      />
      {capture.menu}
      {menu.open && (
        <MenuPopup
          at={menu.open}
          items={moreItems}
          label={t('browser.more')}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
