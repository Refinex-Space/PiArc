import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isProjectPath, projectRecord } from '../../shared/project-files.js';
import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { useSurfaceDocument } from '../app/surface-document.js';
import { attachSnippet } from '../composer/snippets.js';
import { useSession } from '../store/hooks.js';
import { showTerminal } from '../terminal/panel-state.js';
import { FolderIcon, SearchIcon, RailIcon } from '../shell/icons.js';
import { ToolHeaderContent } from '../shell/ToolHeaderSlot.js';
import { Dialog } from '../shell/Dialog.js';
import type { MenuItem } from '../shell/Menu.js';
import { PanelEmpty } from '../shell/PanelEmpty.js';
import { showPanel } from '../shell/registry.js';
import { usePanelPresentation } from '../shell/WorkbenchPanels.js';
import { useUi } from '../shell/ui.js';
import { reason } from '../shell/errors.js';
import { FileTree, type TreeOpenOptions } from './FileTree.js';
import { FileActionsMenu, type FileActions, type FileMenuPoint } from './FileActionsMenu.js';
import {
  FileViewer,
  discardViewerDraft,
  type FileSelection,
  type ViewerRequest,
} from './FileViewer.js';
import { FileBreadcrumb } from './FileBreadcrumb.js';
import { FileSettings, useFileSettings } from './FileSettings.js';
import { FileTabStrip } from './FileTabs.js';
import { closeFiles, restoreTabs, selectFile } from './file-tabs.js';
import {
  attachProjectFiles,
  onFileLocation,
  takeFileLocation,
  projectFileRoot,
} from './navigation.js';
import { onFilesControl } from './file-controls.js';
import { useFileWatch } from './use-file-watch.js';

export function FilesPanel({ id }: { id: string }) {
  const t = useT(),
    ui = useUi(),
    session = useSession(id),
    doc = useSurfaceDocument();
  const { guardClose } = usePanelPresentation();
  const root = projectFileRoot(session);
  const [tabs, setTabs] = useState(() => restoreTabs(id)),
    [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [settings, setSettings] = useFileSettings();
  const [previewTabs, setPreviewTabs] = useState(
    () => localStorage.getItem('piarc.files.preview-tabs') !== 'false',
  );
  const [treeShown, setTreeShown] = useState(true),
    [smallTree, setSmallTree] = useState(true);
  const [width, setWidth] = useState(
    () => Number(localStorage.getItem('piarc.files.tree-width')) || 240,
  );
  const [innerWidth, setInnerWidth] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [filter, setFilter] = useState<{ mode: 'filename' | 'content'; nonce: number }>();
  const [reveal, setReveal] = useState<{ path: string; nonce: number }>();
  const [location, setLocation] = useState<{
    path: string;
    line: number;
    endLine?: number;
    column?: number;
    nonce: number;
  }>();
  const [command, setCommand] = useState<ViewerRequest & { file: string }>();
  const [fileMenu, setFileMenu] = useState<{
    path: string;
    directory: boolean;
    tab: boolean;
    at: FileMenuPoint;
  }>();
  const [confirm, setConfirm] = useState<{ names: readonly string[]; apply: () => void }>();
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([]);
  const [dirs, setDirs] = useState<readonly string[]>(['']);
  const revision = useFileWatch(id, dirs, tabs.active, doc);
  const small = innerWidth > 0 && innerWidth < 440;
  const showTree = small ? smallTree || !tabs.active : treeShown;
  const showingOnlyTree = small && showTree;
  const active = tabs.active;
  const toast = useRef(ui.addToast);
  toast.current = ui.addToast;
  const report = useCallback(
    (error: unknown) => {
      toast.current({ sessionId: id, text: t('files.failed', { reason: reason(error) }) });
    },
    [id, t],
  );
  useEffect(() => {
    let live = true;
    void window.piarc
      .projectFileAction(id, '', 'editors')
      .then((s) => {
        const v: unknown = JSON.parse(s);
        if (live && Array.isArray(v))
          setEditors(
            v.flatMap((r: unknown) =>
              projectRecord(r) && typeof r.id === 'string' && typeof r.name === 'string'
                ? [{ id: r.id, name: r.name }]
                : [],
            ),
          );
      })
      .catch((e: unknown) => {
        if (live) report(e);
      });
    return () => {
      live = false;
    };
  }, [id, report]);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => {
      setInnerWidth(node.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem('piarc.files.tabs.' + id, JSON.stringify(tabs));
  }, [id, tabs]);
  useEffect(() => {
    localStorage.setItem('piarc.files.preferences', JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    localStorage.setItem('piarc.files.preview-tabs', String(previewTabs));
  }, [previewTabs]);
  const markDirty = useCallback((p: string, modified: boolean) => {
    setDirty((old) => {
      if (old.has(p) === modified) return old;
      const next = new Set(old);
      if (modified) next.add(p);
      else next.delete(p);
      return next;
    });
    if (modified) setTabs((old) => (old.preview === p ? { ...old, preview: null } : old));
  }, []);
  const select = useCallback(
    (p: string, options: TreeOpenOptions & { endLine?: number } = {}) => {
      if (!isProjectPath(p)) return;
      setTabs((old) => selectFile(old, p, !!options.pinned || !previewTabs));
      setSmallTree(false);
      if (options.line)
        setLocation({
          path: p,
          line: options.line,
          ...(options.column ? { column: options.column } : {}),
          ...(options.endLine ? { endLine: options.endLine } : {}),
          nonce: performance.now(),
        });
    },
    [previewTabs],
  );
  useEffect(() => {
    const take = () => {
      const next = takeFileLocation(id);
      if (next) {
        select(next.path, next);
        setReveal({ path: next.path, nonce: performance.now() });
      }
    };
    take();
    return onFileLocation((key) => {
      if (id === key) take();
    });
  }, [id, select]);
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'projectFileLink' && event.sessionId === id) select(event.path);
        else if (event.type === 'projectWebLink' && event.sessionId === id)
          void window.piarc.openExternal(event.url).catch(report);
      }),
    [id, select, report],
  );
  const close = useCallback(
    (names: readonly string[], after?: () => void) => {
      const affected = names.filter((p) => dirty.has(p));
      const apply = () => {
        for (const name of names) {
          discardViewerDraft(id, name);
          markDirty(name, false);
        }
        setTabs((old) => closeFiles(old, names));
        after?.();
      };
      if (affected.length) setConfirm({ names: affected, apply });
      else apply();
    },
    [dirty, id, markDirty],
  );
  useEffect(
    () =>
      guardClose('files', (proceed) => {
        if (dirty.size) close([...dirty], proceed);
        else proceed();
      }),
    [guardClose, dirty, close],
  );
  const attach = useCallback(
    (p: string, selection?: FileSelection) => {
      showPanel('conversation');
      if (selection) {
        const lines =
          p +
          '#L' +
          String(selection.startLine) +
          (selection.endLine === selection.startLine ? '' : '-L' + String(selection.endLine));
        attachSnippet(id, {
          label: lines,
          source: lines,
          text: selection.text + (selection.comment ? '\n\n' + selection.comment : ''),
        });
      } else attachProjectFiles(id, [p]);
    },
    [id],
  );
  const actions = useMemo<FileActions>(() => {
    const action = (p: string, op: string) => {
      void window.piarc.projectFileAction(id, p, op).catch(report);
    };
    return {
      onAttach: (paths) => {
        showPanel('conversation');
        attachProjectFiles(id, paths);
      },
      onAsk: (p, line, text) => {
        attach(p, { startLine: line, endLine: line, text });
      },
      onReveal: (p) => {
        action(p, 'reveal');
      },
      onOpenExternal: (p) => {
        action(p, 'open');
      },
      editors,
      onOpenEditor: (p, editor, line) => {
        action(p, 'editor:' + editor + (line ? ':' + String(line) : ''));
      },
      onError: report,
      onTerminal: (p) => {
        void window.piarc
          .openSessionTerminal(id, { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }, p)
          .then((opened) => {
            showPanel('terminal');
            showTerminal(id, opened.taskId);
          })
          .catch(report);
      },
    };
  }, [id, attach, editors, report]);
  const showInTree = (p: string) => {
    setTreeShown(true);
    setSmallTree(true);
    setReveal({ path: p, nonce: performance.now() });
  };
  const focusSearch = () => {
    setTreeShown(true);
    setSmallTree(true);
    setFilter({ mode: 'filename', nonce: performance.now() });
  };
  const toggleTree = () => {
    if (small) setSmallTree((v) => !v);
    else setTreeShown((v) => !v);
  };
  const controls = useRef({ focusSearch, toggleTree });
  controls.current = { focusSearch, toggleTree };
  useEffect(
    () =>
      onFilesControl(id, (action) => {
        if (action === 'search') controls.current.focusSearch();
        else controls.current.toggleTree();
      }),
    [id],
  );
  const issue = (action: ViewerRequest['action']) => {
    if (active) setCommand({ action, file: active, nonce: performance.now() });
  };
  const setTreeWidth = (n: number) => {
    setWidth(Math.round(Math.min(Math.max(120, n), Math.max(120, innerWidth - 180))));
  };
  const keep = (p: string) => {
    setTabs((old) => (old.preview === p ? { ...old, preview: null } : old));
  };
  const extra: MenuItem[] = [];
  if (fileMenu?.tab) {
    const p = fileMenu.path,
      i = tabs.paths.indexOf(p);
    if (tabs.preview === p)
      extra.push({
        id: 'keep',
        label: t('files.keep'),
        run: () => {
          keep(p);
        },
      });
    for (const [key, names] of [
      ['one', [p]],
      ['others', tabs.paths.filter((q) => q !== p)],
      ['left', tabs.paths.slice(0, i)],
      ['right', tabs.paths.slice(i + 1)],
      ['all', tabs.paths],
    ] as const)
      extra.push({
        id: key,
        label: t(`files.close.${key}`),
        disabled: !names.length,
        run: () => {
          close(names);
        },
      });
  }
  return (
    <>
      <ToolHeaderContent>
        <div className="files-heading">
          <IconButton
            label={t(showTree ? 'files.hideTree' : 'files.showTree')}
            aria-pressed={showTree}
            onClick={toggleTree}
          >
            <RailIcon />
          </IconButton>
          {tabs.paths.length ? (
            <FileTabStrip
              tabs={tabs}
              dirty={dirty}
              select={select}
              keep={keep}
              close={(p) => {
                close([p]);
              }}
              menu={(path, at) => {
                setFileMenu({ path, at, directory: false, tab: true });
              }}
              reorder={(from, to) => {
                setTabs((old) => {
                  const paths = old.paths.filter((p) => p !== from);
                  paths.splice(old.paths.indexOf(to), 0, from);
                  return { ...old, paths };
                });
              }}
            />
          ) : (
            <span className="files-header-title">{t('tiles.files')}</span>
          )}
          <IconButton label={t('files.quick')} onClick={focusSearch}>
            <SearchIcon />
          </IconButton>
          <FileSettings
            settings={settings}
            change={setSettings}
            showTree={showTree}
            toggleTree={toggleTree}
            previewTabs={previewTabs}
            togglePreview={() => {
              setPreviewTabs(!previewTabs);
              if (previewTabs) setTabs((old) => ({ ...old, preview: null }));
            }}
            active={!!active}
            issue={issue}
            download={() => {
              if (active) void window.piarc.projectFileAction(id, active, 'download').catch(report);
            }}
          />
        </div>
      </ToolHeaderContent>
      <div
        className="files-workspace"
        data-testid="project-files"
        ref={body}
        data-only-tree={showingOnlyTree}
      >
        <div
          className="files-browser"
          hidden={!showTree}
          style={{ width: Math.max(120, Math.min(innerWidth - 180, width)) }}
        >
          <FileTree
            sessionId={id}
            root={root}
            activePath={active}
            actions={actions}
            onWatchDirectories={setDirs}
            onOpen={select}
            revision={revision}
            {...(reveal ? { reveal } : {})}
            {...(filter ? { filterRequest: filter } : {})}
          />
        </div>
        {showTree && !small && (
          <div
            tabIndex={0}
            role="separator"
            className="files-divider"
            aria-orientation="vertical"
            aria-label={t('files.resize')}
            aria-valuemin={120}
            aria-valuemax={Math.max(innerWidth - 180, 120)}
            aria-valuenow={Math.max(120, Math.min(innerWidth - 180, width))}
            onDoubleClick={() => {
              setTreeWidth(240);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                x: e.clientX,
                width:
                  e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? width,
              };
            }}
            onPointerMove={(e) => {
              if (drag.current) setTreeWidth(drag.current.width + e.clientX - drag.current.x);
            }}
            onLostPointerCapture={() => {
              drag.current = undefined;
              localStorage.setItem('piarc.files.tree-width', String(width));
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                setTreeWidth(
                  Math.min(width, innerWidth - 180) + (e.key === 'ArrowRight' ? 16 : -16),
                );
              }
            }}
          />
        )}
        <div className="files-reader" hidden={showingOnlyTree}>
          {!active && (
            <PanelEmpty
              icon={<FolderIcon />}
              testId="file-viewer-empty"
              title={t('files.empty')}
              description={t('files.emptyHint')}
            />
          )}
          {tabs.paths.map((path) => (
            <div role="tabpanel" aria-label={path} key={path} hidden={path !== active}>
              <FileViewer
                sessionId={id}
                path={path}
                root={root}
                settings={settings}
                fileActions={actions}
                onAttach={attach}
                onDirtyChange={markDirty}
                onOpenFile={(p) => {
                  select(p);
                }}
                onRevealInTree={showInTree}
                visible={path === active && !showingOnlyTree}
                refreshKey={revision}
                {...(path === active && command?.file === path ? { request: command } : {})}
                {...(location?.path === path ? { location } : {})}
                breadcrumb={
                  <FileBreadcrumb
                    sessionId={id}
                    path={path}
                    open={select}
                    actions={(selected, directory, at) => {
                      setFileMenu({ path: selected, directory, at, tab: false });
                    }}
                  />
                }
              />
            </div>
          ))}
        </div>
      </div>
      {fileMenu && (
        <FileActionsMenu
          at={fileMenu.at}
          root={root}
          entries={[{ path: fileMenu.path, directory: fileMenu.directory }]}
          actions={actions}
          extraItems={extra}
          onRevealInTree={showInTree}
          onClose={() => {
            setFileMenu(undefined);
          }}
        />
      )}
      {confirm && (
        <Dialog
          labelledBy="files-discard-title"
          onCancel={() => {
            setConfirm(undefined);
          }}
        >
          <h2 id="files-discard-title">{t('files.discardTitle')}</h2>
          <p>{confirm.names.join(', ')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              data-autofocus
              onClick={() => {
                setConfirm(undefined);
              }}
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                confirm.apply();
                setConfirm(undefined);
              }}
            >
              {t('files.discard')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
