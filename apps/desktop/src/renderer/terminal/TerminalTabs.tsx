// Terminals are keyed by Core task id. Choosing a tab by keyboard keeps focus on the strip.
import { useRef, useState } from 'react';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { CloseIcon, TerminalIcon } from '../shell/icons.js';
import { MenuPopup, useMenu } from '../shell/Menu.js';
import { renameTerminal } from './panel-state.js';

export interface TerminalTab {
  readonly taskId: string;
  readonly terminalId: number;
  readonly agent: boolean;
  readonly shared: boolean;
  readonly startedAt: number;
}

export function TerminalTabs({
  tabs,
  active,
  nameOf,
  onSelect,
  onClose,
}: {
  readonly tabs: readonly TerminalTab[];
  readonly active: TerminalTab | undefined;
  readonly nameOf: (tab: TerminalTab, index: number) => string;
  readonly onSelect: (tab: TerminalTab, focusShell: boolean) => void;
  readonly onClose: (tab: TerminalTab) => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string>();
  const [target, setTarget] = useState<string>();
  const menu = useMenu();
  const targetIndex = tabs.findIndex((tab) => tab.taskId === target);
  const targetTab = tabs[targetIndex];
  const focusTab = (id: string) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[role=tab]');
    Array.from(buttons ?? [])
      .find((button) => button.dataset.task === id)
      ?.focus();
  };
  return (
    <>
      <div ref={list} className="terminal-tablist" role="tablist" aria-label={t('panel.terminal')}>
        {tabs.map((tab, index) => {
          const selected = tab.taskId === active?.taskId;
          const label = nameOf(tab, index);
          const context = (x: number, y: number) => {
            setTarget(tab.taskId);
            menu.openAt(x, y);
          };
          return (
            <div
              key={tab.taskId}
              role="presentation"
              className="terminal-tab-slot"
              data-selected={selected || undefined}
            >
              {renaming === tab.taskId ? (
                <input
                  className="terminal-tab-rename"
                  aria-label={t('terminal.renameLabel')}
                  defaultValue={label}
                  autoFocus
                  maxLength={80}
                  data-testid="terminal-rename"
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                  onBlur={(event) => {
                    renameTerminal(tab.taskId, event.currentTarget.value);
                    setRenaming(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (isImeComposing(event.nativeEvent)) return;
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === 'Enter')
                        renameTerminal(tab.taskId, event.currentTarget.value);
                      setRenaming(undefined);
                      requestAnimationFrame(() => {
                        focusTab(tab.taskId);
                      });
                    }
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="terminal-tab"
                    data-testid="terminal-tab"
                    data-task={tab.taskId}
                    data-terminal={tab.terminalId}
                    aria-keyshortcuts="F2 Delete Shift+F10"
                    title={label}
                    onClick={() => {
                      onSelect(tab, true);
                    }}
                    onDoubleClick={() => {
                      setRenaming(tab.taskId);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.currentTarget.focus();
                      context(event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => {
                      if (isImeComposing(event.nativeEvent)) return;
                      let destination: TerminalTab | undefined;
                      switch (event.key) {
                        case 'ArrowLeft':
                          destination = tabs[(index - 1 + tabs.length) % tabs.length];
                          break;
                        case 'ArrowRight':
                          destination = tabs[(index + 1) % tabs.length];
                          break;
                        case 'Home':
                          destination = tabs[0];
                          break;
                        case 'End':
                          destination = tabs.at(-1);
                          break;
                        case 'F2':
                          setRenaming(tab.taskId);
                          break;
                        case 'Delete':
                          onClose(tab);
                          break;
                        case 'Enter':
                        case ' ':
                          onSelect(tab, true);
                          break;
                        case 'F10':
                        case 'ContextMenu': {
                          if (event.key === 'F10' && !event.shiftKey) return;
                          const rect = event.currentTarget.getBoundingClientRect();
                          context(rect.left, rect.bottom);
                          break;
                        }
                        default:
                          return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      if (destination) {
                        onSelect(destination, false);
                        focusTab(destination.taskId);
                      }
                    }}
                  >
                    <TerminalIcon />
                    <span className="terminal-tab-name">{label}</span>
                    {tab.agent && (
                      <span className="terminal-tab-badge">{t('terminal.agentBadge')}</span>
                    )}
                  </button>
                  {/* Delete and the tab's context menu expose the same close action to keyboard users. */}
                  <span
                    aria-hidden="true"
                    className="terminal-tab-close"
                    data-testid="terminal-tab-close"
                    title={t('terminal.close', { name: label })}
                    onClick={() => {
                      onClose(tab);
                    }}
                  >
                    <CloseIcon />
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {menu.open && targetTab && (
        <MenuPopup
          at={menu.open}
          onClose={menu.close}
          label={nameOf(targetTab, targetIndex)}
          items={[
            {
              id: 'terminal-rename-tab',
              label: t('terminal.rename', { name: nameOf(targetTab, targetIndex) }),
              run: () => {
                setRenaming(targetTab.taskId);
              },
            },
            {
              id: 'terminal-close-tab',
              label: t('terminal.close', { name: nameOf(targetTab, targetIndex) }),
              danger: true,
              run: () => {
                onClose(targetTab);
              },
            },
          ]}
        />
      )}
    </>
  );
}
