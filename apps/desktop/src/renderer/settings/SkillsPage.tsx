// "Skills & plugins" (T37, T40, ADR-0102): what is installed, as tabs with counts (skills,
// packages, the Pi extensions they bring, prompt templates, output styles) over rows of one
// shape; an item's page (a trail back in place of the title); and the Pi package market
// (`MarketView`). The address follows the view: `#/settings/skills?tab=<tab>[&item=<name>]` and
// `#/settings/skills?view=market[&package=<npm name>]`.
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import { StoreIcon } from '../shell/icons.js';
import { parseWorkspaces } from './AgentsPage.js';
import {
  CatalogEmpty,
  CatalogSearch,
  CatalogTabs,
  CatalogToolbar,
  Crumbs,
  type CatalogTab,
} from './catalog.js';
import {
  parseSkills,
  PromptDetail,
  PromptRows,
  SkillDetail,
  SkillRows,
  StylesPanel,
  useCommands,
  type SkillsView,
} from './installed.js';
import { MarketView } from './market/MarketView.js';
import { PageHeadActions, PageHeading } from './page-head.js';
import {
  ExtensionRows,
  InstallDialog,
  MissingPackages,
  PackageDetail,
  PackageNotices,
  PackageRows,
  usePackages,
} from './PluginsSection.js';
import { ScopePicker } from './ScopePicker.js';
import { WorkspaceOptions } from './WorkspaceOptions.js';

export { parseSkills, warningText } from './installed.js';

export type InstalledTab = 'skills' | 'plugins' | 'extensions' | 'prompts' | 'styles';
const TABS: readonly InstalledTab[] = ['skills', 'plugins', 'extensions', 'prompts', 'styles'];

export type Route =
  | { readonly view: 'installed'; readonly tab: InstalledTab; readonly item?: string }
  | { readonly view: 'market'; readonly pkg?: string };

const isTab = (value: string | null): value is InstalledTab => TABS.some((tab) => tab === value);

/** The view the address asks for. */
export function routeOf(hash: string): Route {
  const query = /\?(.*)$/u.exec(hash)?.[1] ?? '';
  const params = new URLSearchParams(query);
  if (params.get('view') === 'market') {
    const pkg = params.get('package');
    return pkg === null || pkg === '' ? { view: 'market' } : { view: 'market', pkg };
  }
  const tab = params.get('tab');
  const item = params.get('item');
  return {
    view: 'installed',
    tab: isTab(tab) ? tab : 'skills',
    ...(item === null || item === '' ? {} : { item }),
  };
}

/** The address of a view (`routeOf` reads it back). */
export function hashOf(route: Route): string {
  const params = new URLSearchParams();
  if (route.view === 'market') {
    params.set('view', 'market');
    if (route.pkg !== undefined) params.set('package', route.pkg);
  } else {
    if (route.tab !== 'skills') params.set('tab', route.tab);
    if (route.item !== undefined) params.set('item', route.item);
  }
  const query = params.toString().replace(/\+/gu, '%20');
  return '#/settings/skills' + (query === '' ? '' : '?' + query);
}

const TAB_LABELS: Record<InstalledTab, MessageId> = {
  skills: 'catalog.tab.skills',
  plugins: 'catalog.tab.plugins',
  extensions: 'catalog.tab.extensions',
  prompts: 'catalog.tab.prompts',
  styles: 'catalog.tab.styles',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function SkillsPage() {
  const { t } = useApp();
  const selectId = useId();
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [skills, setSkills] = useState<SkillsView | undefined>(undefined);
  const [skillsError, setSkillsError] = useState('');
  const [query, setQuery] = useState('');
  const [installing, setInstalling] = useState(false);
  const packages = usePackages(chosen);
  const commands = useCommands(chosen);
  // The market installs and uninstalls: coming back from it reads what is installed again.
  const [revision, setRevision] = useState(0);
  const { load: loadPackages } = packages;
  const { load: loadCommands } = commands;
  const inMarket = route.view === 'market';
  const wasInMarket = useRef(inMarket);
  useEffect(() => {
    if (wasInMarket.current && !inMarket) {
      loadPackages();
      loadCommands();
      setRevision((r) => r + 1);
    }
    wasInMarket.current = inMarket;
  }, [inMarket, loadPackages, loadCommands]);

  const go = useCallback((next: Route) => {
    setRoute(next);
    window.history.replaceState(null, '', hashOf(next));
    document.querySelector('.settings-page')?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    // A link to this page (`hashchange`) chooses the view; the page keeps the address current.
    const onHash = () => {
      if (!/^#\/settings\/skills(?:\?|$)/u.test(window.location.hash)) return;
      setRoute(routeOf(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => {
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        const known = parseWorkspaces(raw);
        setWorkspaces(known.workspaces);
        setChosen((current) => current ?? known.workspace);
      })
      .catch((e: unknown) => {
        setSkillsError(reason(e));
      });
  }, []);
  useEffect(() => {
    // Project-only installs need the project trusted; the diagnostics say whether it is.
    if (chosen === null) {
      setTrusted(false);
      return;
    }
    let live = true;
    window.piarc
      .configDiagnostics(chosen)
      .then((raw) => {
        const value: unknown = JSON.parse(raw);
        if (live) setTrusted(isRecord(value) && value.trusted === true);
      })
      .catch(() => {
        if (live) setTrusted(false);
      });
    return () => {
      live = false;
    };
  }, [chosen]);
  useEffect(() => {
    if (chosen === null) return;
    setSkills(undefined);
    window.piarc
      .listSkills(chosen)
      .then((raw) => {
        setSkillsError('');
        setSkills(parseSkills(raw));
      })
      .catch((e: unknown) => {
        setSkillsError(t('skills.failed', { reason: reason(e) }));
      });
  }, [chosen, t, revision]);

  const toList = useCallback(
    (tab: InstalledTab) => {
      go({ view: 'installed', tab });
    },
    [go],
  );
  const showMarket = useCallback(
    (pkg?: string) => {
      go(pkg === undefined ? { view: 'market' } : { view: 'market', pkg });
    },
    [go],
  );

  const picker =
    chosen === null ? null : (
      <ScopePicker>
        <select
          id={selectId}
          aria-label={t('permissions.workspace')}
          className="settings-scope-select"
          value={chosen}
          data-testid="skills-workspace"
          onChange={(e) => {
            setChosen(e.currentTarget.value);
          }}
        >
          <WorkspaceOptions workspaces={workspaces} />
        </select>
      </ScopePicker>
    );

  if (route.view === 'market') {
    return (
      <div className="settings-detail-page catalog-page" data-testid="skills-page">
        <MarketView
          key={route.pkg ?? ''}
          target={{ workspace: chosen, trusted }}
          headActions={picker}
          {...(route.pkg === undefined ? {} : { initialPackage: route.pkg })}
          onPackage={(name) => {
            window.history.replaceState(
              null,
              '',
              hashOf(name === null ? { view: 'market' } : { view: 'market', pkg: name }),
            );
          }}
          onLeave={() => {
            toList('plugins');
          }}
        />
      </div>
    );
  }

  const tab = route.tab;
  const extensionCount = (packages.list?.packages ?? []).reduce(
    (n, p) => n + (p.components.extensions ?? []).length,
    0,
  );
  const counts: Record<InstalledTab, number | undefined> = {
    skills: skills?.skills.length,
    plugins: packages.list?.packages.length,
    extensions: packages.list === undefined ? undefined : extensionCount,
    prompts: commands.list?.prompts.length,
    styles: commands.list?.styles.styles.length,
  };
  const tabs: CatalogTab<InstalledTab>[] = TABS.map((id) => ({
    id,
    label: t(TAB_LABELS[id]),
    count: counts[id],
  }));
  const needsWorkspace = tab === 'skills' || tab === 'prompts' || tab === 'styles';
  const open = (item: string) => {
    go({ view: 'installed', tab, item });
  };

  if (route.item !== undefined) {
    const item = route.item;
    const back = () => {
      toList(tab);
    };
    const skill = tab === 'skills' ? skills?.skills.find((s) => s.name === item) : undefined;
    const prompt =
      tab === 'prompts' ? commands.list?.prompts.find((p) => p.name === item) : undefined;
    return (
      <div className="settings-detail-page catalog-page" data-testid="skills-page">
        <PageHeading>
          <Crumbs
            items={[
              { label: t('settings.skills'), onClick: back, testId: 'skills-view-installed' },
              { label: tab === 'prompts' ? `/${item}` : item },
            ]}
          />
        </PageHeading>
        <PageHeadActions>{picker}</PageHeadActions>
        {(tab === 'plugins' || tab === 'extensions') && (
          <PackageDetail id={item} packages={packages} workspace={chosen} onGone={back} />
        )}
        {skill !== undefined && chosen !== null && <SkillDetail skill={skill} workspace={chosen} />}
        {prompt !== undefined && <PromptDetail prompt={prompt} />}
      </div>
    );
  }

  return (
    <div className="settings-detail-page catalog-page" data-testid="skills-page">
      <PageHeadActions>
        {picker}
        <Button
          size="small"
          data-testid="skills-view-market"
          onClick={() => {
            showMarket();
          }}
        >
          <StoreIcon />
          {t('catalog.browseMarket')}
        </Button>
        <Button
          size="small"
          variant="primary"
          data-testid="package-install-open"
          disabled={packages.busy}
          onClick={() => {
            setInstalling(true);
          }}
        >
          {t('catalog.add')}
        </Button>
      </PageHeadActions>
      <section className="catalog-view" data-testid="plugins-section">
        <CatalogToolbar>
          <CatalogTabs
            label={t('catalog.tabs')}
            tabs={tabs}
            value={tab}
            testIdPrefix="skills-tab"
            onChange={(next) => {
              setQuery('');
              toList(next);
            }}
          />
          {tab !== 'styles' && (
            <CatalogSearch
              value={query}
              label={t('catalog.filter')}
              testId="skill-filter"
              onChange={setQuery}
            />
          )}
        </CatalogToolbar>
        {needsWorkspace && chosen === null ? (
          <CatalogEmpty>{t('agents.noWorkspace')}</CatalogEmpty>
        ) : (
          <>
            {tab === 'skills' &&
              (skillsError !== '' ? (
                <p className="catalog-notice is-danger" role="alert">
                  {skillsError}
                </p>
              ) : skills === undefined ? null : (
                <SkillRows view={skills} query={query} onOpen={open} />
              ))}
            {(tab === 'plugins' || tab === 'extensions') && <PackageNotices packages={packages} />}
            {tab === 'plugins' && (
              <>
                <MissingPackages
                  packages={packages}
                  onMarket={(name) => {
                    showMarket(name);
                  }}
                />
                <PackageRows packages={packages} workspace={chosen} query={query} onOpen={open} />
              </>
            )}
            {tab === 'extensions' && (
              <ExtensionRows packages={packages} query={query} onOpen={open} />
            )}
            {tab === 'prompts' && commands.list !== undefined && (
              <PromptRows prompts={commands.list.prompts} query={query} onOpen={open} />
            )}
            {tab === 'styles' && commands.list !== undefined && (
              <StylesPanel styles={commands.list.styles} onChanged={commands.load} />
            )}
            {(tab === 'prompts' || tab === 'styles') && commands.error !== '' && (
              <p className="catalog-notice is-danger" role="alert">
                {commands.error}
              </p>
            )}
          </>
        )}
      </section>
      {installing && (
        <InstallDialog
          workspace={chosen}
          operation={packages.operation}
          act={(label, run, done) => {
            packages.act(label, run, (ok) => {
              done?.(ok);
              if (ok) toList('plugins');
            });
          }}
          onClose={() => {
            setInstalling(false);
          }}
        />
      )}
    </div>
  );
}
