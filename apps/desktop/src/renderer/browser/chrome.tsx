// The browser's chrome (B1.1, B1.2): the tab strip in the tile's title row, grouped by Space
// when there is more than one, and the navigation row with the address bar.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type {
  BrowserSessionState,
  BrowserSpaceState,
  BrowserTabState,
} from '../../shared/browser.js';
import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import {
  BackIcon,
  ChevronRightIcon,
  CloseIcon,
  DeviceIcon,
  DevtoolsIcon,
  GlobeIcon,
  LockIcon,
  MoreIcon,
  PlusIcon,
  ReloadIcon,
  SearchIcon,
  ShieldAlertIcon,
  StopIcon,
  UnlockIcon,
} from '../shell/icons.js';

export interface ChromeActions {
  readonly newTab: () => void;
  readonly select: (tab: string) => void;
  readonly close: (tab: string) => void;
  readonly move: (tab: string, index: number) => void;
  readonly tabMenu: (tab: string) => void;
  readonly navigate: (input: string) => void;
  readonly back: () => void;
  readonly forward: () => void;
  readonly reload: (hard: boolean) => void;
  readonly stop: () => void;
  readonly toggleFind: () => void;
  readonly toggleDevice: () => void;
  readonly devtools: () => void;
  readonly more: (anchor: HTMLElement) => void;
}

function spaceLabel(space: BrowserSpaceState, t: ReturnType<typeof useT>): string {
  return space.kind === 'user'
    ? t('browser.space.mine')
    : t('browser.space.agent', { name: space.name });
}

/** A tab's label: its title, its host, or "New tab". */
export function tabTitle(tab: BrowserTabState, t: ReturnType<typeof useT>): string {
  if (tab.title !== '') return tab.title;
  try {
    const host = new URL(tab.url).host;
    if (host !== '') return host;
  } catch {
    // Not a URL yet.
  }
  return t('browser.untitled');
}

export function TabStrip({
  state,
  actions,
}: {
  readonly state: BrowserSessionState;
  readonly actions: ChromeActions;
}) {
  const t = useT();
  const dragged = useRef<string | null>(null);
  const grouped = state.spaces.length > 1;
  return (
    <div
      className="browser-tabs"
      role="tablist"
      aria-label={t('browser.tabs')}
      data-testid="browser-tabs"
    >
      {state.spaces.map((space) => {
        const tabs = state.tabs.filter((tab) => tab.space === space.id);
        if (tabs.length === 0 && grouped) return null;
        return (
          <div key={space.id} className="browser-space" data-space-kind={space.kind}>
            {grouped && (
              <span
                className="browser-space-label"
                data-running={space.running}
                data-ownership={space.ownership}
              >
                {spaceLabel(space, t)}
              </span>
            )}
            {tabs.map((tab) => {
              const index = state.tabs.indexOf(tab);
              const selected = tab.id === state.activeTab;
              const title = tabTitle(tab, t);
              return (
                <div
                  key={tab.id}
                  className="browser-tab"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  data-testid="browser-tab"
                  data-tab={tab.id}
                  data-opened-by={tab.openedBy}
                  draggable
                  data-tooltip={tab.url}
                  onClick={() => {
                    actions.select(tab.id);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) actions.close(tab.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    actions.tabMenu(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (isImeComposing(event.nativeEvent)) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      actions.select(tab.id);
                    }
                  }}
                  onDragStart={(event) => {
                    dragged.current = tab.id;
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    if (dragged.current !== null) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = dragged.current;
                    dragged.current = null;
                    if (from !== null && from !== tab.id) actions.move(from, index);
                  }}
                >
                  <span className="browser-tab-icon" aria-hidden="true">
                    {tab.loading ? (
                      <span className="browser-spinner" />
                    ) : tab.favicon === undefined ? (
                      <GlobeIcon size={12} />
                    ) : (
                      <img src={tab.favicon} alt="" width={12} height={12} />
                    )}
                  </span>
                  <span className="browser-tab-title">{title}</span>
                  {tab.openedBy === 'agent' && (
                    <span className="browser-tab-agent" aria-label={t('browser.agentTab')} />
                  )}
                  <IconButton
                    size="xs"
                    className="browser-tab-close"
                    label={t('browser.closeTab')}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.close(tab.id);
                    }}
                  >
                    <CloseIcon size={12} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        );
      })}
      <IconButton
        size="xs"
        label={t('browser.newTab')}
        keys="Mod+T"
        data-testid="browser-new-tab"
        onClick={actions.newTab}
      >
        <PlusIcon size={12} />
      </IconButton>
    </div>
  );
}

const SITE_LABELS = {
  secure: 'browser.site.secure',
  insecure: 'browser.site.insecure',
  local: 'browser.site.local',
  file: 'browser.site.file',
  internal: 'browser.site.internal',
} as const;

function SiteIcon({ tab }: { readonly tab: BrowserTabState | undefined }) {
  const t = useT();
  const security = tab?.security ?? 'internal';
  const label = t(SITE_LABELS[security]);
  return (
    <span
      className="browser-site"
      data-testid="browser-site"
      data-security={security}
      role="img"
      aria-label={label}
      data-tooltip={label}
    >
      {security === 'secure' ? (
        <LockIcon size={12} />
      ) : security === 'insecure' ? (
        <ShieldAlertIcon size={12} />
      ) : security === 'internal' ? (
        <SearchIcon size={12} />
      ) : (
        <UnlockIcon size={12} />
      )}
    </span>
  );
}

export function NavigationRow({
  tab,
  actions,
  focusAddress,
  deviceOn,
  findOn,
}: {
  readonly tab: BrowserTabState | undefined;
  readonly actions: ChromeActions;
  /** Grows by one each time the address bar should take focus (Mod+L). */
  readonly focusAddress: number;
  readonly deviceOn: boolean;
  readonly findOn: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (tab?.url === 'about:blank' ? '' : (tab?.url ?? ''));

  useEffect(() => {
    if (focusAddress === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusAddress]);

  useEffect(() => {
    setDraft(null);
  }, [tab?.id]);

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = event.currentTarget.value;
      setDraft(null);
      actions.navigate(value);
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
      event.currentTarget.blur();
    }
  };

  return (
    <div className="browser-nav" role="toolbar" aria-label={t('tiles.preview')}>
      <IconButton
        size="sm"
        label={t('browser.back')}
        keys="Mod+["
        disabled={tab?.canGoBack !== true}
        data-testid="browser-back"
        onClick={actions.back}
      >
        <BackIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.forward')}
        keys="Mod+]"
        disabled={tab?.canGoForward !== true}
        data-testid="browser-forward"
        onClick={actions.forward}
      >
        <ChevronRightIcon />
      </IconButton>
      {tab?.loading === true ? (
        <IconButton
          size="sm"
          label={t('browser.stop')}
          data-testid="browser-stop"
          onClick={actions.stop}
        >
          <StopIcon />
        </IconButton>
      ) : (
        <IconButton
          size="sm"
          label={t('browser.reload')}
          keys="Mod+R"
          disabled={tab === undefined}
          data-testid="browser-reload"
          onClick={(event) => {
            actions.reload(event.shiftKey);
          }}
        >
          <ReloadIcon />
        </IconButton>
      )}
      <div className="browser-address">
        <SiteIcon tab={tab} />
        <input
          // The rounded field around it draws the one focus ring (accessibility.md, composite
          // fields): the input itself never shows the app's text-field outline.
          data-focus-proxy
          ref={input}
          className="browser-address-input"
          data-testid="browser-address"
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={t('browser.address.label')}
          placeholder={t('browser.address.placeholder')}
          value={shown}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onBlur={() => {
            setDraft(null);
          }}
          onKeyDown={onKey}
        />
        {tab !== undefined && tab.zoom !== 100 && (
          <span className="browser-zoom" data-testid="browser-zoom">
            {t('browser.zoom.reset', { percent: tab.zoom })}
          </span>
        )}
      </div>
      <IconButton
        size="sm"
        label={t('browser.find')}
        keys="Mod+F"
        aria-pressed={findOn}
        disabled={tab === undefined}
        data-testid="browser-find-toggle"
        onClick={actions.toggleFind}
      >
        <SearchIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.device')}
        keys="Mod+Shift+M"
        aria-pressed={deviceOn}
        disabled={tab === undefined}
        data-testid="browser-device-toggle"
        onClick={actions.toggleDevice}
      >
        <DeviceIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.devtools')}
        keys="F12"
        aria-pressed={tab !== undefined && tab.devtools !== 'closed'}
        disabled={tab === undefined}
        data-testid="browser-devtools"
        onClick={actions.devtools}
      >
        <DevtoolsIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.more')}
        aria-haspopup="menu"
        data-testid="browser-more"
        onClick={(event) => {
          actions.more(event.currentTarget);
        }}
      >
        <MoreIcon />
      </IconButton>
    </div>
  );
}
