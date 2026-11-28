// The action of a market entry (ADR-0102). In a row it is quiet: "+" installs for every
// project, "Update", "Turn on" or "Use here" as small ghost buttons, a check when it is on. On
// the package's page it is the primary button, with "this project only" in its menu. Installing
// never turns a package on; turning on is always the native confirmation's decision.
import type { MarketEntry } from '@piarc/protocol';

import { useApp } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { IconButton } from '../../app/IconButton.js';
import { MenuPopup, useMenu } from '../../shell/Menu.js';
import { CheckIcon, ChevronDownIcon, PlusIcon } from '../../shell/icons.js';
import { actionOf } from './market-data.js';

export interface MarketTarget {
  /** The workspace the page shows (`null`: no project open). */
  readonly workspace: string | null;
  /** Whether that project is trusted (project-only installs need it). */
  readonly trusted: boolean;
}

/** Runs one action on package `name`; answers the text to show, or throws. Only that
 * package's controls wait for it (Core runs npm operations one after another). */
export type MarketRun = (name: string, label: string, run: () => Promise<string | null>) => void;

export function MarketAction({
  entry,
  target,
  busy,
  run,
  size = 'row',
}: {
  readonly entry: MarketEntry;
  readonly target: MarketTarget;
  /** Another operation on this package runs. */
  readonly busy: boolean;
  readonly run: MarketRun;
  /** `row`: the list's quiet control; `page`: the package page's primary button. */
  readonly size?: 'row' | 'page';
}) {
  const { t } = useApp();
  const menu = useMenu();
  const action = actionOf(entry, target.workspace);
  const name = entry.name;
  const page = size === 'page';
  const testId = `market-action-${name}`;
  const install = (scope: 'user' | 'project') => {
    run(name, t('market.installing', { name }), async () => {
      await window.piarc.marketInstall({
        name,
        version: entry.version,
        scope,
        workspace: scope === 'project' ? target.workspace : null,
      });
      return t('market.installed', { name });
    });
  };
  const enable = (id: string, scope: 'user' | 'project') => {
    run(name, t('market.enabling', { name }), async () => {
      const answer = await window.piarc.setPackageEnabled(
        id,
        true,
        scope,
        scope === 'project' ? target.workspace : null,
      );
      return answer.includes('"cancelled"') ? null : t('market.enabled', { name });
    });
  };
  const variant = page ? 'primary' : 'ghost';
  switch (action.kind) {
    case 'installing':
      return (
        <Button size="small" variant={variant} loading disabled data-testid={testId}>
          {t('market.action.install')}
        </Button>
      );
    case 'update':
      return (
        <Button
          size="small"
          variant={variant}
          disabled={busy}
          data-testid={testId}
          data-action="update"
          onClick={() => {
            run(name, t('market.updating', { name }), async () => {
              await window.piarc.updatePackage(action.id, target.workspace);
              return t('market.updated', { name, version: action.version });
            });
          }}
        >
          {page
            ? t('market.action.update', { version: action.version })
            : t('market.action.updateShort')}
        </Button>
      );
    case 'enable':
      return (
        <Button
          size="small"
          variant={variant}
          disabled={busy}
          data-testid={testId}
          data-action="enable"
          onClick={() => {
            enable(action.id, action.scope);
          }}
        >
          {t('market.action.enable')}
        </Button>
      );
    case 'addHere':
      return (
        <Button
          size="small"
          variant={variant}
          disabled={busy || !target.trusted}
          data-testid={testId}
          data-action="addHere"
          data-tooltip={target.trusted ? undefined : t('market.untrusted')}
          onClick={() => {
            enable(action.id, 'project');
          }}
        >
          {t('market.action.addHere')}
        </Button>
      );
    case 'enabled':
      return page ? (
        <span className="market-state" data-testid={testId} data-action="enabled">
          <CheckIcon />
          {t('market.action.on')}
        </span>
      ) : (
        <span
          className="market-state is-icon"
          data-testid={testId}
          data-action="enabled"
          role="img"
          aria-label={t('market.action.on')}
          data-tooltip={t('market.action.on')}
        >
          <CheckIcon />
        </span>
      );
    case 'install':
      if (!page) {
        return (
          <IconButton
            size="sm"
            label={t('market.installNamed', { name })}
            disabled={busy}
            data-testid={testId}
            data-action="install"
            onClick={() => {
              install('user');
            }}
          >
            <PlusIcon />
          </IconButton>
        );
      }
      return (
        <span className="market-install">
          <Button
            size="small"
            variant="primary"
            disabled={busy}
            data-testid={testId}
            data-action="install"
            onClick={() => {
              install('user');
            }}
          >
            {t('market.action.install')}
          </Button>
          <IconButton
            size="sm"
            label={t('market.installOptions', { name })}
            className="market-install-more"
            disabled={busy}
            data-testid={`${testId}-more`}
            aria-haspopup="menu"
            aria-expanded={menu.open !== null}
            onClick={(e) => {
              menu.openBelowEnd(e.currentTarget);
            }}
          >
            <ChevronDownIcon />
          </IconButton>
          {menu.open !== null && (
            <MenuPopup
              at={menu.open}
              label={t('market.installOptions', { name })}
              onClose={menu.close}
              items={[
                {
                  id: 'user',
                  testId: `${testId}-user`,
                  label: t('market.scope.user'),
                  hint: t('market.scope.userHint'),
                  run: () => {
                    install('user');
                  },
                },
                {
                  id: 'project',
                  testId: `${testId}-project`,
                  label: t('market.scope.project'),
                  disabled: target.workspace === null || !target.trusted,
                  hint:
                    target.workspace === null
                      ? t('market.noProject')
                      : target.trusted
                        ? t('market.scope.projectHint')
                        : t('market.untrusted'),
                  run: () => {
                    install('project');
                  },
                },
              ]}
            />
          )}
        </span>
      );
  }
}
