// The browser's chrome (B1.1, B1.2): the tab strip in the tile's title row, grouped by Space
// when there is more than one, and the navigation row with the address bar.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type {
  BrowserSessionState,
  BrowserSpaceState,
  BrowserTabState,
} from '../../shared/browser.js';
import { useApp, useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { MenuPopup, useMenu } from '../shell/Menu.js';
import { SuggestionList, useSuggestions, type SuggestFetch } from './suggest.js';
import {
  BackIcon,
  ChevronRightIcon,
  CloseIcon,
  DeviceIcon,
  DevtoolsIcon,
  GlobeIcon,
  AnnotateIcon,
  LockIcon,
  MoreIcon,
  PickIcon,
  PlusIcon,
  ReloadIcon,
  ScreenshotIcon,
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
  /** Opens `input` in the shown tab, or in a new tab with `newTab` (Mod+Enter). */
  readonly navigate: (input: string, newTab?: boolean) => void;
  /** The address bar's suggestions (B1.2.3). */
  readonly suggest?: SuggestFetch;
  readonly back: () => void;
  readonly forward: () => void;
  readonly reload: (hard: boolean) => void;
  readonly stop: () => void;
  readonly toggleFind: () => void;
  readonly toggleDevice: () => void;
  readonly devtools: () => void;
  readonly more: (anchor: HTMLElement) => void;
  /** The element picker on or off (B3.1). */
  readonly pick: () => void;
  /** Freezes the page and annotates its screenshot (B3.3). */
  readonly annotate: () => void;
  /** The screenshot menu (B3.4). */
  readonly screenshot: (anchor: HTMLElement) => void;
  /** The site information menu's "Import this site's sign-ins from Chrome" (B5.1). */
  readonly importSite?: (host: string) => void;
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
    // The new-tab button sits beside the tablist: a tablist owns only tabs.
    <div className="browser-tabbar">
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
                    aria-keyshortcuts="Delete"
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
                      } else if (event.key === 'Delete' || event.key === 'Backspace') {
                        event.preventDefault();
                        actions.close(tab.id);
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
                    {/* A tab's content is presentational, so the close control is for the
                        pointer only; on a focused tab Delete closes it (aria-keyshortcuts). */}
                    <span
                      className="icon-button workbench-icon is-xs browser-tab-close"
                      aria-hidden="true"
                      data-tooltip={t('browser.closeTab')}
                      data-testid="browser-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        actions.close(tab.id);
                      }}
                    >
                      <CloseIcon size={12} />
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
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

/** The host of an http(s) page, for the site information menu. */
function webHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname.replace(/^\[|\]$/g, '')
      : undefined;
  } catch {
    return undefined;
  }
}

function SiteIcon({
  tab,
  onImport,
}: {
  readonly tab: BrowserTabState | undefined;
  readonly onImport?: (host: string) => void;
}) {
  const t = useT();
  const menu = useMenu();
  const security = tab?.security ?? 'internal';
  const label = t(SITE_LABELS[security]);
  const icon =
    security === 'secure' ? (
      <LockIcon size={12} />
    ) : security === 'insecure' ? (
      <ShieldAlertIcon size={12} />
    ) : security === 'internal' ? (
      <SearchIcon size={12} />
    ) : (
      <UnlockIcon size={12} />
    );
  const host = webHost(tab?.url);
  if (onImport === undefined || host === undefined) {
    return (
      <span
        className="browser-site"
        data-testid="browser-site"
        data-security={security}
        role="img"
        aria-label={label}
        data-tooltip={label}
      >
        {icon}
      </span>
    );
  }
  // The site information menu (B5.1): importing this site's sign-ins from Chrome.
  return (
    <>
      <button
        type="button"
        className="browser-site"
        data-testid="browser-site"
        data-security={security}
        aria-label={label}
        aria-haspopup="menu"
        data-tooltip={label}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          menu.openAt(rect.left, rect.bottom + 4, event.currentTarget);
        }}
      >
        {icon}
      </button>
      {menu.open && (
        <MenuPopup
          at={menu.open}
          label={label}
          onClose={menu.close}
          items={[
            {
              id: 'chrome-import',
              label: t('browserImport.siteMenu'),
              run: () => {
                onImport(host);
              },
            },
          ]}
        />
      )}
    </>
  );
}

export function NavigationRow({
  tab,
  actions,
  focusAddress,
  deviceOn,
  findOn,
  picking = false,
  annotating = false,
}: {
  readonly tab: BrowserTabState | undefined;
  readonly actions: ChromeActions;
  /** Grows by one each time the address bar should take focus (Mod+L). */
  readonly focusAddress: number;
  readonly deviceOn: boolean;
  readonly findOn: boolean;
  readonly picking?: boolean;
  readonly annotating?: boolean;
}) {
  const pageOpen = tab !== undefined && tab.url !== '' && !tab.crashed;
  const t = useT();
  const { keyPlatform } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (tab?.url === 'about:blank' ? '' : (tab?.url ?? ''));
  const suggestions = useSuggestions(actions.suggest);
  const go = (value: string, newTab: boolean) => {
    suggestions.close();
    setDraft(null);
    actions.navigate(value, newTab);
    input.current?.blur();
  };

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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.move(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const mod = keyPlatform === 'mac' ? event.metaKey : event.ctrlKey;
      go(suggestions.chosen()?.url ?? event.currentTarget.value, mod);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (suggestions.open) {
        suggestions.close();
        return;
      }
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
      <div className="browser-address" data-suggesting={suggestions.open}>
        <SiteIcon tab={tab} {...(actions.importSite ? { onImport: actions.importSite } : {})} />
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
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.open}
          aria-controls={suggestions.open ? suggestions.listId : undefined}
          aria-activedescendant={
            suggestions.open && suggestions.selected >= 0
              ? suggestions.optionId(suggestions.selected)
              : undefined
          }
          value={shown}
          onChange={(event) => {
            setDraft(event.target.value);
            // Composition text is not asked about; `compositionend` asks for the result.
            const native = event.nativeEvent;
            if (!(native instanceof InputEvent && native.isComposing)) {
              suggestions.request(event.target.value);
            }
          }}
          onCompositionEnd={(event) => {
            suggestions.request(event.currentTarget.value);
          }}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onBlur={() => {
            setDraft(null);
            suggestions.close();
          }}
          onKeyDown={onKey}
        />
        <SuggestionList
          suggestions={suggestions}
          onPick={(item, newTab) => {
            go(item.url, newTab);
          }}
        />
        {tab !== undefined && tab.zoom !== 100 && (
          <span className="browser-zoom" data-testid="browser-zoom">
            {t('browser.zoom.reset', { percent: tab.zoom })}
          </span>
        )}
      </div>
      <IconButton
        size="sm"
        label={t('browser.pick')}
        keys="Mod+Shift+S"
        aria-pressed={picking}
        disabled={!pageOpen || annotating}
        data-testid="browser-pick-toggle"
        onClick={actions.pick}
      >
        <PickIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.annotate')}
        keys="Mod+Shift+X"
        aria-pressed={annotating}
        disabled={!pageOpen}
        data-testid="browser-annotate-toggle"
        onClick={actions.annotate}
      >
        <AnnotateIcon />
      </IconButton>
      <IconButton
        size="sm"
        label={t('browser.screenshot')}
        aria-haspopup="menu"
        disabled={!pageOpen || annotating}
        data-testid="browser-screenshot"
        onClick={(event) => {
          actions.screenshot(event.currentTarget);
        }}
      >
        <ScreenshotIcon />
      </IconButton>
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
