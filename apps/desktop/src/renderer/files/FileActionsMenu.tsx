import { createPortal } from 'react-dom';
import { canOpenSystemDocument } from '../../shared/project-files.js';
import { useApp } from '../app/app-context.js';
import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
import { MenuPopup, type MenuItem } from '../shell/Menu.js';
import { absoluteFilePath } from './file-path.js';

export interface FileActions {
  readonly onAttach: (paths: readonly string[]) => void;
  readonly onReveal: (path: string) => void;
  readonly onTerminal?: (directory: string) => void;
  readonly editors?: readonly { readonly id: string; readonly name: string }[];
  readonly onOpenEditor?: (path: string, editorId: string, line?: number) => void;
  readonly onOpenExternal?: (path: string) => void;
  readonly onAsk?: (path: string, line: number, snippet: string) => void;
  readonly onError?: (message: string) => void;
}

export interface FileMenuEntry {
  readonly path: string;
  readonly directory?: boolean;
  readonly blocked?: boolean;
  readonly gone?: boolean;
  readonly line?: number;
  readonly snippet?: string;
}

export interface FileMenuPoint {
  readonly x: number;
  readonly y: number;
  readonly anchor?: HTMLElement;
}

export function FileActionsMenu({
  at,
  root,
  entries,
  actions,
  onRevealInTree,
  extraItems,
  documentItems,
  onClose,
}: {
  readonly at: FileMenuPoint;
  readonly root: string;
  readonly entries: readonly FileMenuEntry[];
  readonly actions: FileActions;
  readonly onRevealInTree?: (path: string) => void;
  readonly extraItems?: readonly MenuItem[];
  readonly documentItems?: readonly MenuItem[] | undefined;
  readonly onClose: () => void;
}) {
  const { t, platform } = useApp();
  const win = documentWindow(useSurfaceDocument());
  const first = entries[0];
  if (!first) return null;
  const paths = entries.map((entry) => entry.path);
  const single = entries.length === 1;
  const many = entries.length > 100;
  const copy = (kind: 'absolute' | 'relative' | 'filename') => {
    const values = paths.map((path) =>
      kind === 'absolute'
        ? absoluteFilePath(root, path)
        : kind === 'relative'
          ? path
          : path.slice(path.lastIndexOf('/') + 1),
    );
    // Clipboard controls from a filename can inject an extra command line on paste.
    const value = values
      .map((path) =>
        Array.from(path)
          .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
          .join(''),
      )
      .join('\n');
    void win.navigator.clipboard.writeText(value).catch((e: unknown) => {
      if (actions.onError) actions.onError(t('files.tree.copyFailed'));
      else console.error('[files] clipboard write failed', e);
    });
  };
  const items: MenuItem[] = [
    {
      id: 'attach',
      label: t('files.tree.attach'),
      disabled: many || entries.some((entry) => entry.blocked),
      ...(many ? { hint: t('files.tree.attachLimit') } : {}),
      run: () => {
        actions.onAttach(paths);
      },
    },
    {
      id: 'copy',
      label: t('files.tree.copy'),
      submenu: [
        {
          id: 'absolute',
          label: t('files.tree.absolute'),
          run: () => {
            copy('absolute');
          },
        },
        {
          id: 'relative',
          label: t('files.tree.relative'),
          run: () => {
            copy('relative');
          },
        },
        {
          id: 'filename',
          label: t('files.tree.filename'),
          run: () => {
            copy('filename');
          },
        },
      ],
    },
  ];
  const targets = entries.filter((entry) => !entry.blocked && !entry.gone);
  const editors: MenuItem[] = actions.onOpenEditor
    ? (actions.editors ?? []).map((editor) => ({
        id: editor.id,
        label: editor.name,
        disabled: many,
        run: () => {
          for (const entry of targets) actions.onOpenEditor?.(entry.path, editor.id, entry.line);
        },
      }))
    : [];
  if (
    single &&
    !first.blocked &&
    !first.gone &&
    actions.onOpenExternal &&
    !first.directory &&
    canOpenSystemDocument(first.path)
  ) {
    editors.push({
      id: 'defaultApp',
      label: t('files.tree.defaultApp'),
      run: () => actions.onOpenExternal?.(first.path),
    });
  }
  if (editors.length && targets.length)
    items.push({ id: 'openIn', label: t('files.tree.openIn'), submenu: editors });
  if (single && !first.blocked && !first.gone) {
    items.push({
      id: 'reveal',
      label: t(platform === 'darwin' ? 'files.tree.finder' : 'files.tree.explorer'),
      run: () => {
        actions.onReveal(first.path);
      },
    });
    if (first.directory && actions.onTerminal)
      items.push({
        id: 'terminal',
        label: t('files.tree.terminal'),
        run: () => actions.onTerminal?.(first.path),
      });
    if (onRevealInTree)
      items.push({
        id: 'tree',
        label: t('files.tree.reveal'),
        run: () => {
          onRevealInTree(first.path);
        },
      });
    if (first.line && first.snippet !== undefined && actions.onAsk) {
      const { line, snippet } = first;
      items.push({
        id: 'ask',
        label: t('files.tree.ask'),
        run: () => actions.onAsk?.(first.path, line, snippet),
      });
    }
  }
  return createPortal(
    <MenuPopup
      items={
        documentItems
          ? [
              ...documentItems,
              {
                id: 'md-file',
                label: t('md.selection.file'),
                submenu: [...items, ...(extraItems ?? [])],
              },
            ]
          : [...items, ...(extraItems ?? [])]
      }

      at={at}
      onClose={onClose}
      label={t(documentItems ? 'md.selection.menu' : 'files.tree.actions')}
      testId="file-actions-menu"
    />,
    win.document.body,
  );
}
