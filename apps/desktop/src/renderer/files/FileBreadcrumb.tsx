import { Fragment, useEffect, useState } from 'react';
import { useT } from '../app/app-context.js';
import { ChevronRightIcon, FileIcon, FolderIcon } from '../shell/icons.js';
import { MenuPopup, type MenuItem } from '../shell/Menu.js';
import { listProjectFiles, type ProjectEntry } from './api.js';
import type { FileMenuPoint } from './FileActionsMenu.js';
import { reason } from '../shell/errors.js';

export function FileBreadcrumb({
  sessionId,
  path,
  open,
  actions,
}: {
  sessionId: string;
  path: string;
  open: (path: string) => void;
  actions: (path: string, directory: boolean, at: FileMenuPoint) => void;
}) {
  const t = useT();
  const [folder, setFolder] = useState<{ path: string; at: FileMenuPoint }>();
  const [page, setPage] = useState<{ path: string; entries: ProjectEntry[]; error?: string }>();
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void listProjectFiles(sessionId, folder.path).then(
      (result) => {
        if (live) setPage({ path: folder.path, entries: result.entries });
      },
      (e: unknown) => {
        if (live) setPage({ path: folder.path, entries: [], error: reason(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, folder]);
  const items: MenuItem[] = [];
  if (folder) {
    if (folder.path)
      items.push({
        id: 'up',
        label: '..',
        run: () => {
          setFolder({ ...folder, path: folder.path.split('/').slice(0, -1).join('/') });
        },
      });
    if (page?.path === folder.path)
      items.push(
        ...page.entries.map((entry) => ({
          id: entry.path,
          label: entry.name,
          icon: entry.kind === 'directory' ? <FolderIcon /> : <FileIcon />,
          disabled: !!entry.link && entry.link.state !== 'ok',
          run: () => {
            if (entry.kind === 'directory') setFolder({ path: entry.path, at: folder.at });
            else {
              setFolder(undefined);
              open(entry.path);
            }
          },
        })),
      );
  }
  return (
    <>
      <nav aria-label={t('files.breadcrumb')} className="files-crumbs">
        {path.split('/').map((name, i, parts) => {
          const segment = parts.slice(0, i + 1).join('/'),
            dir = i !== parts.length - 1;
          return (
            <Fragment key={segment}>
              {i > 0 && <ChevronRightIcon />}
              <button
                type="button"
                title={segment}
                aria-haspopup="menu"
                onContextMenu={(e) => {
                  e.preventDefault();
                  actions(segment, dir, { x: e.clientX, y: e.clientY });
                }}
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  setFolder({
                    path: dir ? segment : parts.slice(0, -1).join('/'),
                    at: { x: b.left, y: b.bottom, anchor: e.currentTarget },
                  });
                }}
              >
                {name}
              </button>
            </Fragment>
          );
        })}
      </nav>
      {folder && (
        <MenuPopup
          key={folder.path}
          at={folder.at}
          label={t('files.breadcrumb')}
          filterLabel={t('files.tree.filter')}
          items={
            items.length
              ? items
              : [
                  {
                    id: 'status',
                    label:
                      page?.path !== folder.path
                        ? t('files.viewer.loading')
                        : (page.error ?? t('files.tree.empty')),
                    disabled: true,
                    run: () => undefined,
                  },
                ]
          }
          onClose={() => {
            setFolder(undefined);
          }}
        />
      )}
    </>
  );
}
