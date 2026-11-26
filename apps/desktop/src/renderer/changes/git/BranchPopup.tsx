// The branch popup (SPEC B5, after IntelliJ's branches popup): a filter field, "New branch",
// checking out a tag or revision typed in the field, then recent, local and remote branches.
// Enter or a click opens a branch's actions: check out, new branch from it, rename, delete,
// set or unset the upstream, push. Anything Git refuses comes back as a notice or a prompt.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { useT } from '../../app/app-context.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { isImeComposing } from '../../composer/ime-guard.js';
import { MenuPopup, useMenu, type MenuItem } from '../../shell/Menu.js';
import { useHistoryActions } from './history-actions.js';
import { CheckIcon, GitBranchIcon, PlusIcon, SpinnerGlyph, TagIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import { fuzzyFilter } from '../../../shared/fuzzy.js';
import { setPrompt, type GitActions } from './actions.js';
import type { LocalBranch, RemoteBranch, Repository } from './protocol.js';
import { gitSession, type GitSnapshot } from './state.js';

/** Branches a group shows before "show all". */
const GROUP_LIMIT = 50;

type Row =
  | { readonly kind: 'new' }
  | { readonly kind: 'revision'; readonly target: string }
  | { readonly kind: 'local'; readonly branch: LocalBranch; readonly group: 'recent' | 'local' }
  | { readonly kind: 'remote'; readonly branch: RemoteBranch };

function rowKey(row: Row): string {
  switch (row.kind) {
    case 'new':
      return 'new';
    case 'revision':
      return `rev:${row.target}`;
    case 'local':
      return `${row.group}:${row.branch.name}`;
    case 'remote':
      return `remote:${row.branch.remote}/${row.branch.name}`;
  }
}

export function BranchPopup({
  sessionId,
  git,
  repo,
  anchor,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly anchor: HTMLElement;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const doc = useSurfaceDocument();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number }>();
  const menu = useMenu();
  const history = useHistoryActions(sessionId, actions);
  const locked = repo.writable ? {} : { disabled: true, hint: t('git.log.untrusted') };
  const integrate = (name: string): MenuItem[] => {
    const current = revealBidi(repo.branch ?? 'HEAD');
    return [
      {
        id: 'merge',
        label: t('git.branch.mergeInto', { current }),
        testId: 'git-branch-merge',
        ...locked,
        run: () => {
          onClose();
          setPrompt(sessionId, { kind: 'merge', branch: name });
        },
      },
      {
        id: 'rebase',
        label: t('git.branch.rebaseOnto', { current }),
        testId: 'git-branch-rebase',
        ...(repo.detached ? { disabled: true } : locked),
        run: () => {
          onClose();
          // A branch with an upstream has pushed commits: rewriting them needs a force push.
          if (repo.upstream === undefined) void actions.rebase(name);
          else setPrompt(sessionId, { kind: 'rebase', onto: name });
        },
      },
    ];
  };
  const [menuRow, setMenuRow] = useState<Row | undefined>(undefined);
  const branches = git.branches.value;
  useEffect(() => {
    void gitSession(sessionId).loadBranches(true);
  }, [sessionId]);
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const view = doc.documentElement.clientHeight;
    setPlace({
      left: box.left,
      top: box.bottom + 4,
      maxHeight: Math.max(200, view - box.bottom - 16),
    });
  }, [anchor, doc]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target) === true || anchor.contains(target)) return;
      // The actions menu is a separate popup; it closes itself.
      if (target instanceof Element && target.closest('[role="menu"]') !== null) return;
      onClose();
    };
    doc.addEventListener('pointerdown', away, true);
    return () => {
      doc.removeEventListener('pointerdown', away, true);
    };
  }, [doc, anchor, onClose]);
  const rows = useMemo((): Row[] => {
    if (branches === undefined) return [];
    const q = query.trim();
    const local = q === '' ? branches.local : fuzzyFilter(branches.local, q, (b) => [b.name]);
    const remote =
      q === ''
        ? branches.remote
        : fuzzyFilter(branches.remote, q, (b) => [`${b.remote}/${b.name}`]);
    const recent =
      q === ''
        ? branches.recent
            .filter((name) => name !== repo.branch)
            .flatMap((name) => {
              const b = branches.local.find((l) => l.name === name);
              return b === undefined ? [] : [b];
            })
            .slice(0, 5)
        : [];
    const limit = showAll || q !== '' ? Infinity : GROUP_LIMIT;
    const exact =
      branches.local.some((b) => b.name === q) ||
      branches.remote.some((b) => `${b.remote}/${b.name}` === q);
    return [
      { kind: 'new' },
      ...(q !== '' && !exact ? [{ kind: 'revision' as const, target: q }] : []),
      ...recent.map((branch) => ({ kind: 'local' as const, branch, group: 'recent' as const })),
      ...local
        .slice(0, limit)
        .map((branch) => ({ kind: 'local' as const, branch, group: 'local' as const })),
      ...remote.slice(0, limit).map((branch) => ({ kind: 'remote' as const, branch })),
    ];
  }, [branches, query, repo.branch, showAll]);
  useEffect(() => {
    setActive(query.trim() === '' ? 0 : Math.min(1, rows.length - 1));
  }, [query, rows.length]);
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${String(active)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const newBranch = (start?: string) => {
    onClose();
    setPrompt(sessionId, { kind: 'branchName', mode: 'create', start });
  };
  const rowMenu = (row: Row): MenuItem[] => {
    if (row.kind === 'local') {
      const b = row.branch;
      const current = b.current;
      return [
        ...(current
          ? []
          : [
              {
                id: 'checkout',
                label: t('git.branch.checkout'),
                testId: 'git-branch-checkout',
                ...(b.worktree === undefined
                  ? {}
                  : { disabled: true, hint: t('git.branch.inWorktree', { path: b.worktree }) }),
                run: () => {
                  onClose();
                  void actions.checkout(b.name);
                },
              },
            ]),
        {
          id: 'new',
          label: t('git.branch.newFrom', { name: b.name }),
          run: () => {
            newBranch(b.name);
          },
        },
        ...(current ? [] : integrate(b.name)),
        {
          id: 'rename',
          label: t('git.branch.rename'),
          testId: 'git-branch-rename',
          run: () => {
            onClose();
            setPrompt(sessionId, { kind: 'branchName', mode: 'rename', from: b.name });
          },
        },
        ...(current && repo.remotes.length > 0
          ? [
              {
                id: 'push',
                label: t('git.branch.push'),
                run: () => {
                  onClose();
                  void actions.push();
                },
              },
            ]
          : []),
        ...(b.upstream === undefined
          ? repo.remotes.length === 0
            ? []
            : [
                {
                  id: 'track',
                  label: t('git.branch.setUpstream'),
                  submenu: (branches?.remote ?? [])
                    .filter((r) => r.name === b.name)
                    .map((r) => ({
                      id: `${r.remote}/${r.name}`,
                      label: `${r.remote}/${r.name}`,
                      run: () => {
                        onClose();
                        void actions.setUpstream(b.name, `${r.remote}/${r.name}`);
                      },
                    })),
                } satisfies MenuItem,
              ].filter((item) => item.submenu.length > 0)
          : [
              {
                id: 'untrack',
                label: t('git.branch.unsetUpstream', { upstream: b.upstream }),
                run: () => {
                  onClose();
                  void actions.setUpstream(b.name, undefined);
                },
              },
            ]),
        ...(current
          ? []
          : [
              {
                id: 'delete',
                label: t('git.branch.delete'),
                danger: true,
                testId: 'git-branch-delete',
                run: () => {
                  onClose();
                  void actions.deleteBranch(b.name);
                },
              },
            ]),
      ];
    }
    if (row.kind === 'remote') {
      const full = `${row.branch.remote}/${row.branch.name}`;
      const exists = branches?.local.some((l) => l.name === row.branch.name) === true;
      return [
        {
          id: 'checkout',
          label: exists
            ? t('git.branch.checkoutExisting', { name: row.branch.name })
            : t('git.branch.checkoutTracking', { name: row.branch.name }),
          testId: 'git-branch-checkout',
          run: () => {
            onClose();
            void (exists
              ? actions.checkout(row.branch.name)
              : actions.createBranch(row.branch.name, full, true));
          },
        },
        {
          id: 'new',
          label: t('git.branch.newFrom', { name: full }),
          run: () => {
            newBranch(full);
          },
        },
        ...integrate(full),
        {
          id: 'deleteRemote',
          label: t('git.branch.deleteRemote', { remote: row.branch.remote }),
          testId: 'git-branch-delete-remote',
          danger: true,
          ...(repo.writable ? {} : { disabled: true, hint: t('git.log.untrusted') }),
          run: () => {
            onClose();
            void history.deleteRemoteBranch(row.branch.remote, row.branch.name);
          },
        },
      ];
    }
    return [];
  };
  const pick = (row: Row, at?: HTMLElement) => {
    if (row.kind === 'new') {
      newBranch();
      return;
    }
    if (row.kind === 'revision') {
      onClose();
      void actions.checkout(row.target);
      return;
    }
    const element =
      at ??
      list.current?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`) ??
      undefined;
    const box = element?.getBoundingClientRect();
    setMenuRow(row);
    menu.openAt(box === undefined ? 0 : box.right - 8, box === undefined ? 0 : box.top, element);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (rows.length === 0 ? 0 : (a + step + rows.length) % rows.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row !== undefined) pick(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.focus();
    }
  };
  const label = (row: Row) => {
    switch (row.kind) {
      case 'new':
        return (
          <>
            <PlusIcon size={12} />
            <span className="git-branch-row-name">{t('git.branch.new')}</span>
          </>
        );
      case 'revision':
        return (
          <>
            <TagIcon size={12} />
            <span className="git-branch-row-name">
              {t('git.branch.checkoutRevision', { target: revealBidi(row.target) })}
            </span>
          </>
        );
      case 'local': {
        const b = row.branch;
        return (
          <>
            {b.current ? <CheckIcon size={12} /> : <GitBranchIcon size={12} />}
            <span className="git-branch-row-name">{revealBidi(b.name)}</span>
            {b.gone ? <span className="git-branch-tag">{t('git.branch.gone')}</span> : null}
            {b.worktree === undefined ? null : (
              <span className="git-branch-tag">{t('git.branch.worktree')}</span>
            )}
            <span className="git-branch-row-meta">
              {(b.ahead ?? 0) > 0 ? `↑${String(b.ahead)}` : ''}
              {(b.behind ?? 0) > 0 ? ` ↓${String(b.behind)}` : ''}
              {b.upstream === undefined ? '' : ` ${revealBidi(b.upstream)}`}
            </span>
          </>
        );
      }
      case 'remote':
        return (
          <>
            <GitBranchIcon size={12} />
            <span className="git-branch-row-name">
              {revealBidi(`${row.branch.remote}/${row.branch.name}`)}
            </span>
          </>
        );
    }
  };
  const groupOfRow = (row: Row) =>
    row.kind === 'local' ? row.group : row.kind === 'remote' ? 'remote' : 'actions';
  const listId = `${id}-list`;
  const hiddenLocal =
    branches !== undefined &&
    !showAll &&
    query.trim() === '' &&
    (branches.local.length > GROUP_LIMIT || branches.remote.length > GROUP_LIMIT);
  return (
    <div
      className="git-branch-popup"
      ref={root}
      role="dialog"
      aria-label={t('git.branch.title')}
      data-testid="git-branch-popup"
      style={
        place === undefined
          ? { visibility: 'hidden' }
          : { left: place.left, top: place.top, maxHeight: place.maxHeight }
      }
    >
      <input
        type="text"
        className="git-goto-input"
        // The popup opens for typing.
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={rows[active] === undefined ? undefined : `${id}-${String(active)}`}
        aria-label={t('git.branch.search')}
        placeholder={t('git.branch.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={onKeyDown}
        data-testid="git-branch-search"
      />
      {branches === undefined ? (
        <p className="git-note" role="status">
          <SpinnerGlyph size={12} /> {t('git.branch.loading')}
        </p>
      ) : null}
      <ul
        className="interactive-list git-branch-list"
        id={listId}
        role="listbox"
        ref={list}
        aria-label={t('git.branch.title')}
      >
        {rows.map((row, index) => {
          const group = groupOfRow(row);
          const previous = rows[index - 1];
          const heading =
            previous === undefined || groupOfRow(previous) !== group ? group : undefined;
          return (
            <li key={rowKey(row)} role="presentation">
              {heading === undefined || heading === 'actions' ? null : (
                <div className="git-branch-group" role="presentation">
                  {t(`git.branch.group.${heading}`)}
                </div>
              )}
              <div
                id={`${id}-${String(index)}`}
                role="option"
                aria-selected={index === active}
                data-index={index}
                data-testid="git-branch-row"
                data-branch={
                  row.kind === 'local'
                    ? row.branch.name
                    : row.kind === 'remote'
                      ? `${row.branch.remote}/${row.branch.name}`
                      : row.kind
                }
                className={index === active ? 'git-branch-row is-active' : 'git-branch-row'}
                onPointerMove={() => {
                  setActive(index);
                }}
                onClick={(event) => {
                  setActive(index);
                  pick(row, event.currentTarget);
                }}
              >
                {label(row)}
              </div>
            </li>
          );
        })}
      </ul>
      {hiddenLocal ? (
        <button
          type="button"
          className="git-link-button git-branch-more"
          onClick={() => {
            setShowAll(true);
          }}
        >
          {t('git.branch.showAll')}
        </button>
      ) : null}
      {menu.open === null || menuRow === undefined ? null : (
        <MenuPopup
          items={rowMenu(menuRow)}
          at={menu.open}
          onClose={menu.close}
          label={t('git.branch.actions')}
          testId="git-branch-menu"
        />
      )}
    </div>
  );
}
