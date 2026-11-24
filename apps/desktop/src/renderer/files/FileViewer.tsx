// One mounted viewer owns one tab, including its undo stack, draft, find state and scroll position.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
import { reason } from '../shell/errors.js';
import {
  CommandIcon,
  FileIcon,
  PaperclipIcon,
  PencilIcon,
  PreviewIcon,
  SearchIcon,
} from '../shell/icons.js';
import { MenuPopup, useMenu, type MenuItem } from '../shell/Menu.js';
import { useUi } from '../shell/ui.js';
import { FileActionsMenu, type FileActions } from './FileActionsMenu.js';
import { useFileDocument } from './viewer-document.js';
import { FileSelectionBar } from './viewer-selection.js';
import { MarkdownActionIcon, MarkdownModes, type FileMode } from './markdown/MarkdownModes.js';
import { ReaderSelectionTools } from './markdown/ReaderSelectionTools.js';
import { MarkdownWorkspace, type MarkdownWorkspaceHandle } from './markdown/MarkdownWorkspace.js';
import { FileEditor } from './viewer-editor.js';
import { GoToLine, ViewerFind, useFileFind } from './viewer-find.js';
import {
  DEFAULT_VIEWER_SETTINGS,
  previewKind,
  replaceMatches,
  selectionFromMatches,
  sourceLines,
  type FileSelection,
  type FindOptions,
  type ViewerSettings,
} from './viewer-model.js';
import { VisibleFilePreview } from './viewer-visibility.js';
import { FilePreview } from './viewer-preview.js';
import { FileSource, type FileLocation } from './viewer-source.js';

export { discardViewerDraft } from './viewer-document.js';
export {
  DEFAULT_VIEWER_SETTINGS,
  type ViewerSettings,
  type FileSelection,
} from './viewer-model.js';
export type { FileLocation } from './viewer-source.js';
export interface ViewerRequest {
  action: 'find' | 'reload' | 'copy' | 'goToLine';
  nonce: number;
}
export interface FileViewerProps {
  sessionId: string;
  path: string;
  location?: FileLocation;
  visible?: boolean;
  refreshKey?: number;
  request?: ViewerRequest;
  breadcrumb?: ReactNode;
  settings?: ViewerSettings;
  root?: string;
  fileActions?: FileActions;
  onOpenFile?: (path: string) => void;
  onRevealInTree?: (path: string) => void;
  onDirtyChange?: (path: string, dirty: boolean) => void;
  onAttach: (path: string, selection?: FileSelection) => void;
}

export function FileViewer({
  sessionId,
  path,
  location,
  visible = true,
  refreshKey = 0,
  request,
  breadcrumb,
  settings = DEFAULT_VIEWER_SETTINGS,
  root,
  fileActions,
  onOpenFile,
  onRevealInTree,
  onDirtyChange,
  onAttach,
}: FileViewerProps) {
  const { t, format } = useApp(),
    { addToast } = useUi();
  const win = documentWindow(useSurfaceDocument());
  const doc = useFileDocument(
    sessionId,
    path,
    visible,
    refreshKey,
    settings.autoSave,
    onDirtyChange,
  );
  const { file, draft } = doc;
  const main = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<FileMode>(doc.dirty ? 'edit' : location ? 'source' : 'preview');
  const [target, setTarget] = useState<FileLocation | undefined>(location);
  const [tools, setTools] = useState<'find' | 'goToLine'>();
  const [query, setQuery] = useState(''),
    [index, setIndex] = useState(0);
  const [options, setOptions] = useState<FindOptions>({
    matchCase: false,
    wholeWord: false,
    regexp: false,
  });
  const [selection, setSelection] = useState<FileSelection>();
  const [comment, setComment] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const lines = useMemo(() => sourceLines(draft), [draft]);
  const find = useFileFind(lines, tools === 'find' ? query : '', options);
  const count = find?.result.matches.length ?? 0,
    current = count ? index % count : 0;
  const match = find?.result.matches[current];
  const canPreviewText = file?.kind === 'text' && previewKind(path) !== null;
  const media = file && ['image', 'audio', 'video', 'pdf'].includes(file.kind);
  const editable = file?.kind === 'text' && file.editable;
  const markdown = file?.kind === 'text' && previewKind(path) === 'markdown';
  const markdownEditor = useRef<MarkdownWorkspaceHandle | null>(null);
  const pendingMarkdownFind = useRef(false);
  useLayoutEffect(() => {
    if (markdown && mode !== 'preview' && pendingMarkdownFind.current) {
      pendingMarkdownFind.current = false;
      markdownEditor.current?.findReplace();
    }
  }, [markdown, mode]);
  const menu = useMenu();
  const [documentItems, setDocumentItems] = useState<MenuItem[]>();
  const menuTicket = useRef(0);
  useEffect(() => {
    if (!visible) {
      menuTicket.current++;
      menu.close();
    }
  }, [visible, menu.close]);

  useEffect(() => {
    if (!markdown || !editable || !visible || mode === 'preview') return;
    const observe = () => {
      if (win.document.hasFocus())
        void window.piarc
          .projectFileAction(sessionId, path, 'observeMarkdownPaste')
          .catch((e: unknown) => {
            console.warn('[files] Markdown paste observer unavailable', reason(e));
          });
    };
    observe();
    win.addEventListener('focus', observe);
    return () => {
      win.removeEventListener('focus', observe);
    };
  }, [markdown, editable, visible, mode, win, sessionId, path]);
  function copy(text: string) {
    void win.navigator.clipboard.writeText(text).catch((e: unknown) => {
      addToast({ sessionId, text: t('files.viewer.copyError', { reason: reason(e) }) });
    });
  }
  const setLine = (next: FileLocation) => {
    setTarget({ ...next, nonce: performance.now() });
    setSelection(undefined);
  };
  useEffect(() => {
    if (location) {
      setMode((previous) => (previous === 'edit' || previous === 'split' ? previous : 'source'));
      setTarget(location);
      setSelection(undefined);
    }
  }, [location]);
  const edit = (line: number) => {
    if (!editable) return;
    setTools(undefined);
    setLine({ line });
    setMode('edit');
  };
  function openTool(tool: 'find' | 'goToLine') {
    if (file?.kind !== 'text') return;
    if (markdown && tool === 'find') {
      setTools(undefined);
      if (mode === 'preview') {
        pendingMarkdownFind.current = true;
        setMode('source');
      } else markdownEditor.current?.findReplace();
      return;
    }
    if (mode !== 'edit' && mode !== 'split') setMode('source');
    setTools(tool);
    if (
      tool === 'find' &&
      selection &&
      !selection.text.includes('\n') &&
      selection.text.length < 160
    ) {
      setQuery(selection.text);
      setIndex(0);
    }
    main.current?.querySelector<HTMLInputElement>('.file-find input')?.focus();
  }
  function closeTool() {
    setTools(undefined);
    if (markdown) markdownEditor.current?.focus();
    else main.current?.querySelector<HTMLElement>('.file-editor,.file-source-scroll')?.focus();
  }
  const reload = () => {
    if (doc.dirty) {
      setConfirmDiscard(true);
      return;
    }
    void doc.load(doc.forced);
  };
  const performed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request || !visible || !file || performed.current === request.nonce) return;
    performed.current = request.nonce;
    switch (request.action) {
      case 'find':
      case 'goToLine':
        openTool(request.action);
        break;
      case 'copy':
        if (file.kind === 'text') copy(draft);
        break;
      case 'reload':
        reload();
        break;
    }
  });
  useLayoutEffect(() => {
    if (tools) main.current?.querySelector<HTMLInputElement>('.file-find input')?.focus();
  }, [tools]);
  const attachSelection = useCallback(
    (selection: FileSelection) => {
      onAttach(path, selection);
      setComment(undefined);
      setSelection(undefined);
    },
    [path, onAttach],
  );
  const commentOn = (value: FileSelection) => {
    setSelection(value);
    setComment('');
  };
  const showBodyMenu = (eventPath: EventTarget[], x: number, y: number, keyboard = false) => {
    const ticket = ++menuTicket.current,
      scope = main.current;
    if (!markdown || !scope) {
      setDocumentItems(undefined);
      menu.openAt(x, y);
      return;
    }
    const report = (e: unknown) => {
      addToast({ sessionId, text: t('files.viewer.failed', { reason: reason(e) }) });
    };
    void import('./markdown/body-context.js')
      .then((module) => {
        if (
          ticket !== menuTicket.current ||
          main.current !== scope ||
          !scope.isConnected ||
          !scope.getClientRects().length
        )
          return;
        const items = module.markdownBodyActions(eventPath, { x, y }, keyboard, lines, {
          t,
          copy: (s) => win.navigator.clipboard.writeText(s),
          paste: () => window.piarc.projectFileAction(sessionId, path, 'pasteMarkdown'),
          attach: attachSelection,
          comment: commentOn,
          report,
          openLink: (address) => {
            module.openMarkdownAddress(address, sessionId, root ?? '', path, report);
          },
        });
        setDocumentItems(items);
        menu.openAt(x, y);
      })
      .catch(report);
  };
  const extra: MenuItem[] = [];
  if (file?.kind === 'image')
    extra.push({
      id: 'copyImage',
      label: t('files.viewer.copyImage'),
      run: () => {
        void window.piarc.projectFileAction(sessionId, path, 'copyImage').then(
          () => {
            addToast({ sessionId, text: t('files.viewer.imageCopied') });
          },
          (error: unknown) => {
            addToast({ sessionId, text: t('files.viewer.copyError', { reason: reason(error) }) });
          },
        );
      },
    });
  if ((mode === 'edit' || (markdown && mode !== 'preview')) && editable)
    extra.push({
      id: 'editorMenu',
      label: t('files.viewer.editActions'),
      run: () => {
        const field = main.current?.querySelector<HTMLTextAreaElement>('.file-editor');
        if (markdown) markdownEditor.current?.focus();
        else if (field) field.focus({ preventScroll: true });
        else return;
        void window.piarc
          .projectFileAction(sessionId, path, 'editorMenu')
          .catch((error: unknown) => {
            addToast({ sessionId, text: t('files.viewer.failed', { reason: reason(error) }) });
          });
      },
    });
  if (selection) {
    extra.push(
      {
        id: 'addSelection',
        label: t('files.viewer.attachSelection'),
        run: () => {
          attachSelection(selection);
        },
      },
      {
        id: 'commentSelection',
        label: t('files.viewer.comment'),
        run: () => {
          setComment('');
        },
      },
      {
        id: 'copySelection',
        label: t('files.viewer.copySelection'),
        run: () => {
          copy(selection.text);
        },
      },
    );
  }
  if (file?.kind === 'text')
    extra.push(
      {
        id: 'copyBody',
        label: t('files.viewer.copyContents'),
        run: () => {
          copy(draft);
        },
      },
      {
        id: 'find',
        label: t('files.viewer.find'),
        run: () => {
          openTool('find');
        },
      },
      {
        id: 'goToLine',
        label: t('files.viewer.goToLine'),
        run: () => {
          openTool('goToLine');
        },
      },
    );
  const preview = file && (
    <FilePreview sessionId={sessionId} file={file} {...(onOpenFile ? { onOpenFile } : {})} />
  );
  const shownPreview =
    media || previewKind(path) === 'html' ? (
      <VisibleFilePreview visible={visible}>{preview}</VisibleFilePreview>
    ) : (
      preview
    );
  return (
    <div
      className="file-viewer"
      ref={main}
      aria-label={path}
      role="group"
      data-testid="file-viewer"
      data-md-session={markdown ? sessionId : undefined}
      data-dirty={doc.dirty || undefined}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const key = event.key.toLowerCase(),
          mod = event.ctrlKey || event.metaKey;
        if (mod && event.shiftKey && !event.altKey && key === 'l' && selection) {
          event.preventDefault();
          event.stopPropagation();
          attachSelection(selection);
        } else if (mod && key === 's' && editable) {
          event.preventDefault();
          event.stopPropagation();
          void doc.save();
        } else if (mod && (key === 'f' || key === 'g') && file?.kind === 'text') {
          event.preventDefault();
          event.stopPropagation();
          openTool(key === 'f' ? 'find' : 'goToLine');
        } else if (key === 'escape' && tools) {
          event.preventDefault();
          event.stopPropagation();
          closeTool();
        }
      }}
    >
      <div className="file-viewer-toolbar" data-markdown={markdown || undefined}>
        <div className="file-viewer-crumb" title={path}>
          {breadcrumb ?? path.split('/').at(-1)}
        </div>
        {file?.kind === 'text' && (
          <>
            {markdown && (
              <MarkdownModes
                mode={mode}
                editable={editable}
                change={(next) => {
                  setTools(undefined);
                  setMode(next);
                }}
              />
            )}
            {!markdown && canPreviewText && !doc.dirty && (
              <IconButton
                label={t(mode === 'preview' ? 'files.viewer.source' : 'files.viewer.preview')}
                onClick={() => {
                  setTools(undefined);
                  setMode(mode === 'preview' ? 'source' : 'preview');
                  setSelection(undefined);
                }}
              >
                {mode === 'preview' ? <CommandIcon /> : <PreviewIcon />}
              </IconButton>
            )}
            {!markdown && mode === 'edit' && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  if (doc.dirty) setConfirmDiscard(true);
                  else setMode('source');
                }}
              >
                {t(doc.dirty ? 'files.viewer.discard' : 'files.viewer.done')}
              </Button>
            )}
            {doc.dirty && (
              <Button size="small" disabled={doc.saving} onClick={() => void doc.save()}>
                {t('files.viewer.save')}
              </Button>
            )}
          </>
        )}
        {file && file.kind !== 'missing' && (
          <div className="file-viewer-actions">
            {file.kind === 'text' && (
              <IconButton
                label={t('files.viewer.find')}
                onClick={() => {
                  openTool('find');
                }}
              >
                {markdown ? <MarkdownActionIcon name="find" /> : <SearchIcon />}
              </IconButton>
            )}
            {file.kind === 'text' && !markdown && editable && mode !== 'edit' && (
              <IconButton
                label={t('files.viewer.edit')}
                onClick={() => {
                  edit(target?.line ?? 1);
                }}
              >
                <PencilIcon />
              </IconButton>
            )}
            {file.kind !== 'missing' && (
              <IconButton
                label={t('files.viewer.attachFile')}
                onClick={() => {
                  onAttach(path);
                }}
              >
                {markdown ? <MarkdownActionIcon name="attach" /> : <PaperclipIcon />}
              </IconButton>
            )}
          </div>
        )}
      </div>
      {doc.failure && (
        <div className="file-viewer-notice" role="alert">
          <span>
            {doc.conflict
              ? t(doc.conflict.kind === 'missing' ? 'files.viewer.deleted' : 'files.viewer.changed')
              : t('files.viewer.failed', { reason: doc.failure })}
          </span>
          {doc.conflict?.editable && (
            <Button size="small" onClick={() => void doc.save(doc.conflict)}>
              {t('files.viewer.keepMine')}
            </Button>
          )}
          <Button
            size="small"
            onClick={() => {
              if (doc.dirty && !doc.conflict) void doc.save();
              else reload();
            }}
          >
            {t(doc.conflict ? 'files.viewer.reload' : 'files.viewer.retry')}
          </Button>
        </div>
      )}
      {confirmDiscard && (
        <div className="file-viewer-notice" role="alert">
          <span>{t('files.viewer.discardQuestion')}</span>
          <Button
            size="small"
            onClick={() => {
              setConfirmDiscard(false);
            }}
          >
            {t('dialog.cancel')}
          </Button>
          <Button
            size="small"
            disabled={doc.saving}
            onClick={() => {
              setConfirmDiscard(false);
              setMode('source');
              void doc.load(doc.forced, true);
            }}
          >
            {t('files.viewer.discard')}
          </Button>
        </div>
      )}
      {tools === 'find' && (
        <ViewerFind
          query={query}
          onQuery={(value) => {
            setQuery(value);
            setIndex(0);
          }}
          options={options}
          onOptions={(value) => {
            setOptions(value);
            setIndex(0);
          }}
          result={find?.result}
          index={current}
          timedOut={!!find?.timedOut}
          step={(n) => {
            setIndex(count ? (current + n + count) % count : 0);
          }}
          close={closeTool}
          editable={editable}
          onReplace={(replacement, all) => {
            if (!editable || (all ? !count : !match)) return;
            const wasLast = !all && current === count - 1;
            const next = replaceMatches(draft, query, replacement, options, all ? 'all' : match);
            if (next === undefined || next === draft) return;
            doc.setDraft(next);
            if (wasLast) setIndex(0);
          }}
          onSelectAll={() => {
            const picked = selectionFromMatches(draft, find?.result.matches ?? []);
            if (picked) setSelection(picked);
          }}
        />
      )}
      {tools === 'goToLine' && (
        <GoToLine
          count={lines.length}
          go={(next) => {
            setLine(next);
            closeTool();
          }}
          closeTool={closeTool}
        />
      )}
      <div
        className="file-viewer-body"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          showBodyMenu(event.nativeEvent.composedPath(), event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            showBodyMenu(event.nativeEvent.composedPath(), box.left + 8, box.top + 8, true);
          }
        }}
      >
        {!file ? (
          !doc.failure && (
            <div className="tool-empty" role="status">
              {t('files.viewer.loading')}
            </div>
          )
        ) : file.kind === 'text' ? (
          markdown ? (
            <MarkdownWorkspace
              ref={markdownEditor}
              sessionId={sessionId}
              path={path}
              text={draft}
              editable={editable}
              mode={mode}
              visible={visible}
              settings={settings}
              location={target}
              match={match}
              onChange={doc.setDraft}
              onSelect={setSelection}
            />
          ) : mode === 'edit' ? (
            <FileEditor
              path={path}
              lines={lines}
              text={draft}
              onChange={doc.setDraft}
              settings={settings}
              location={target}
              match={match}
              onSelect={setSelection}
            />
          ) : mode === 'preview' && canPreviewText ? (
            shownPreview
          ) : (
            <FileSource
              path={path}
              text={draft}
              lines={lines}
              settings={settings}
              location={target}
              match={match}
              matches={find?.result.matches}
              selection={selection}
              onSelect={setSelection}
              onEdit={edit}
            />
          )
        ) : media ? (
          shownPreview
        ) : (
          <div className="tool-empty file-unavailable">
            <FileIcon />
            <p>
              {t(
                file.kind === 'missing'
                  ? 'files.viewer.missing'
                  : file.kind === 'tooLarge'
                    ? 'files.viewer.large'
                    : 'files.viewer.binary',
              )}
            </p>
            {file.kind !== 'missing' && (
              <small>{t('files.viewer.size', { size: format.number(file.size) })}</small>
            )}
            {file.kind === 'missing' && file.editable && (
              <Button
                size="small"
                disabled={doc.saving}
                onClick={() => void doc.save(undefined, true)}
              >
                {t('files.viewer.create')}
              </Button>
            )}
            {file.kind !== 'missing' && !doc.forced && (
              <Button size="small" onClick={() => void doc.load(true)}>
                {t('files.viewer.asText')}
              </Button>
            )}
            {file.kind !== 'missing' && fileActions?.onOpenExternal && (
              <Button size="small" onClick={() => fileActions.onOpenExternal?.(path)}>
                {t('files.tree.defaultApp')}
              </Button>
            )}
          </div>
        )}
        {menu.open &&
          (root && fileActions ? (
            <FileActionsMenu
              at={menu.open}
              root={root}
              entries={[{ path }]}
              actions={fileActions}
              extraItems={extra}
              documentItems={documentItems}
              {...(onRevealInTree ? { onRevealInTree } : {})}
              onClose={menu.close}
            />
          ) : (
            <MenuPopup
              at={menu.open}
              items={[
                ...(documentItems ?? []),
                {
                  id: 'attach',
                  label: t('files.viewer.attachFile'),
                  run: () => {
                    onAttach(path);
                  },
                },
                ...extra,
              ]}
              label={t('files.viewer.actions')}
              onClose={menu.close}
            />
          ))}
      </div>
      {markdown && visible && (mode === 'preview' || mode === 'split') && (
        <ReaderSelectionTools
          scope={main}
          lines={lines}
          copy={copy}
          attach={attachSelection}
          comment={commentOn}
          edit={editable ? edit : undefined}
        />
      )}
      {selection && (
        <FileSelectionBar
          selection={selection}
          comment={comment}
          setComment={setComment}
          attachSelection={attachSelection}
          clear={() => {
            setSelection(undefined);
            setComment(undefined);
          }}
        />
      )}
    </div>
  );
}
