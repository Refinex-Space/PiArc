import { tableActions, type TableAction } from './live-table.js';
import { useRef } from 'react';
import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { GearIcon, PlusIcon, SearchIcon, PaperclipIcon } from '../../shell/icons.js';
import { MenuPopup, useMenu, type MenuItem } from '../../shell/Menu.js';
import type { FormatCommand } from './formatting.js';
const blocks = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'bullet',
  'ordered',
  'task',
  'quote',
] as const;
const insertions = [
  'inlineCode',
  'strike',
  'table',
  'fence',
  'formula',
  'diagram',
  'rule',
] as const;
export function EditorToolbar({
  run,
  image,
  configureImages,
  choose,
  findReplace,
  undo,
  redo,
  canUndo,
  canRedo,
  editable,
  editTable,
}: {
  run: (c: FormatCommand) => void;
  image?: ((files: readonly File[]) => void) | undefined;
  choose?: (() => void) | undefined;
  configureImages?: (() => void) | undefined;
  findReplace: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  editable: boolean;
  editTable?: ((a: TableAction) => void) | undefined;
}) {
  const t = useT(),
    menu = useMenu(),
    picker = useRef<HTMLInputElement>(null);
  const items: MenuItem[] = editable
    ? [
        ...insertions.map((id) => ({
          id,
          label: t(`md.edit.${id}`),
          run: () => {
            run(id);
          },
        })),
        ...(editTable
          ? [
              {
                id: 'tableActions',
                label: t('md.edit.tableActions'),
                submenu: tableActions
                  .filter((a) => a !== 'source')
                  .map((a) => ({
                    id: a,
                    label: t(`md.edit.${a}`),
                    run: () => {
                      editTable(a);
                    },
                  })),
              },
            ]
          : []),
        { id: 'undo', label: t('md.edit.undo'), disabled: !canUndo, run: undo },
        { id: 'redo', label: t('md.edit.redo'), disabled: !canRedo, run: redo },
      ]
    : [];
  return (
    <div className="md-edit-toolbar" role="group" aria-label={t('md.edit.formatting')}>
      {editable && (
        <>
          <select
            className="md-edit-block"
            aria-label={t('md.edit.blockStyle')}
            title={t('md.edit.blockStyle')}
            value=""
            onChange={(e) => {
              const cmd = blocks.find((id) => id === e.target.value);
              if (cmd) run(cmd);
            }}
          >
            <option value="" disabled>
              {t('md.edit.blockStyle')}
            </option>
            {blocks.map((id) => (
              <option key={id} value={id}>
                {t(`md.edit.${id}`)}
              </option>
            ))}
          </select>
          <IconButton
            label={t('md.edit.bold')}
            aria-keyshortcuts="Control+B Meta+B"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              run('bold');
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinejoin="round"
            >
              <path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z" />
            </svg>
          </IconButton>
          <IconButton
            label={t('md.edit.italic')}
            aria-keyshortcuts="Control+I Meta+I"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              run('italic');
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M10 4h9M5 20h9M15 4 9 20" />
            </svg>
          </IconButton>
          <IconButton
            label={t('md.edit.link')}
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              run('link');
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            >
              <path d="M10 13.8a3.5 3.5 0 0 0 4.8 0l3-3a3.5 3.5 0 0 0-5-5l-1.6 1.6M14 10.3a3.5 3.5 0 0 0-4.9.1l-3.1 3.2a3.5 3.5 0 1 0 5 5l1.5-1.6" />
            </svg>
          </IconButton>
          {(image ?? choose) && (
            <>
              <IconButton
                label={t('md.edit.insertImage')}
                onClick={() => {
                  if (choose) choose();
                  else picker.current?.click();
                }}
              >
                <PaperclipIcon />
              </IconButton>
              <input
                ref={picker}
                type="file"
                multiple
                accept="image/*"
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) image?.(files);
                }}
              />
            </>
          )}
          <IconButton
            label={t('md.edit.insert')}
            aria-haspopup="menu"
            aria-expanded={!!menu.open}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              menu.openAt(r.left, r.bottom, e.currentTarget);
            }}
          >
            <PlusIcon />
          </IconButton>
        </>
      )}
      <IconButton label={t('md.edit.findReplace')} onClick={findReplace}>
        <SearchIcon />
      </IconButton>
      {configureImages && (
        <IconButton label={t('md.edit.imageSettings')} onClick={configureImages}>
          <GearIcon />
        </IconButton>
      )}
      {menu.open && (
        <MenuPopup label={t('md.edit.insert')} at={menu.open} items={items} onClose={menu.close} />
      )}
    </div>
  );
}
