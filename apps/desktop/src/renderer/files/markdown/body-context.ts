// Adapted from Marklyra e7c2175, packages/editor-runtime/src/runtime/context-menu-items.ts
// and context-menu-selection.ts (Apache-2.0). Commands restore a snapshot of this file's
// CodeMirror selection. A reload or edit invalidates it; a menu never edits another tab.
import {
  copyLineDown,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { readerRange } from './reader-range.js';
import { mediaContextItem } from './media-context-item.js';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AppContextValue } from '../../app/app-context.js';
import type { MenuItem } from '../../shell/Menu.js';
import type { FileSelection } from '../viewer-model.js';
import { safeHref } from '../../transcript/markdown/text.js';
import { fileLocation, parentPath } from '../file-path.js';
import { openProjectFile } from '../navigation.js';
import { applyFormat, formatActive } from './formatting.js';
import { commandShortcut } from './selection-tools.js';
import { runSlashItem } from './slash-menu.js';
import { slashGroups, type Entry } from './slash-catalog.js';
import { markdownToHtml, selectionMarkup } from './clipboard-markup.js';

type Translator = AppContextValue['t'];
export interface MarkdownMenuPorts {
  t: Translator;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<unknown>;
  attach: (selection: FileSelection) => void;
  comment: (selection: FileSelection) => void;
  openLink: (address: string) => void;
  report: (e: unknown) => void;
}
const inline = [
  'bold',
  'italic',
  'underline',
  'strike',
  'highlight',
  'inlineCode',
  'inlineMath',
  'superscript',
  'subscript',
  'link',
] as const;
const blocks = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'quote',
  'bullet',
  'ordered',
  'task',
] as const;

function linkAt(state: EditorState, pos: number) {
  for (const bias of [1, -1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias); n; n = n.parent) {
      if (n.name === 'Link' || n.name === 'Autolink') {
        const destination = n.getChild('URL');
        if (destination)
          return state.sliceDoc(destination.from, destination.to).replace(/^<|>$/gu, '');
      }
    }
  return undefined;
}
function areaAt(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return n;
    if (n.name === 'FrontMatter' || n.name === 'BlockMath' || n.name === 'HTMLBlock') return n;
  }
  return undefined;
}
function linkItems(address: string | undefined, ports: MarkdownMenuPorts): MenuItem[] {
  if (!address) return [];
  return [
    {
      id: 'md-openLink',
      label: ports.t('md.selection.openLink'),
      run: () => {
        ports.openLink(address);
      },
    },
    {
      id: 'md-copyLink',
      label: ports.t('md.selection.copyLink'),
      run: () => {
        void ports.copy(address).catch(ports.report);
      },
    },
  ];
}
export function editorBodyActions(
  view: EditorView,
  pos: number,
  ports: MarkdownMenuPorts,
): MenuItem[] {
  const initial = view.state,
    doc = initial.doc,
    range = initial.selection.main,
    mount = view.dom.parentNode;
  const at = Math.max(0, Math.min(doc.length, pos));
  const selection =
    at >= range.from && at <= range.to ? initial.selection : EditorSelection.single(at);
  const r = selection.main,
    first = doc.lineAt(r.from),
    last = doc.lineAt(Math.max(r.from, r.to - 1)),
    empty = r.empty;
  const target = {
    startLine: first.number,
    endLine: last.number,
    text: empty ? first.text : initial.sliceDoc(r.from, r.to),
  };
  const snapshot = initial.selection.eq(selection) ? initial : initial.update({ selection }).state;
  const editable = !initial.readOnly,
    area = areaAt(snapshot, at);
  const { t } = ports;
  const restore = () => {
    if (view.state.doc !== doc || view.dom.parentNode !== mount) return false;
    if (!view.state.selection.eq(selection)) view.dispatch({ selection });
    view.focus();
    return true;
  };
  const edit = (command: (view: EditorView) => unknown) => () => {
    if (!view.state.readOnly && !view.composing && restore()) command(view);
  };
  const write = (text: string) => {
    void ports.copy(text).catch(ports.report);
  };
  const fn = (
    name: (typeof inline)[number] | (typeof blocks)[number],
    withState: boolean,
  ): MenuItem => ({
    id: 'md-' + name,
    label: t(`md.edit.${name}`),
    ...(withState ? { selected: formatActive(snapshot, name) } : {}),
    shortcut: commandShortcut(view, name),
    run: edit((v) => applyFormat(v, name, (n) => t('md.edit.column', { n }))),
  });
  const insertEntry = (entry: Entry): MenuItem =>
    'folderId' in entry
      ? {
          id: 'md-insert-' + entry.folderId,
          label: t(entry.label),
          submenu: entry.children.map(insertEntry),
        }
      : {
          id: 'md-insert-' + entry.id,
          label: t(entry.label),
          run: edit((v) => runSlashItem(v, entry.id)),
        };
  const snippet: MenuItem[] = [
    {
      id: 'md-attach',
      label: t('files.viewer.attachSelection'),
      disabled: !target.text,
      run: () => {
        ports.attach(target);
      },
    },
    {
      id: 'md-comment',
      label: t('files.viewer.comment'),
      disabled: !target.text,
      run: () => {
        ports.comment(target);
      },
    },
  ];
  const cutRange = empty ? { from: first.from, to: Math.min(doc.length, first.to + 1) } : r;
  const items: MenuItem[] = [
    ...linkItems(linkAt(snapshot, at), ports),
    {
      id: 'md-cut',
      label: t('md.selection.cut'),
      disabled: !editable || cutRange.to === cutRange.from,
      shortcut: systemKey(view, 'X'),
      run: () => {
        if (!editable || !restore()) return;
        void ports
          .copy(initial.sliceDoc(cutRange.from, cutRange.to))
          .then(() => {
            if (view.state.doc === doc && !view.state.readOnly && view.dom.parentNode === mount)
              view.dispatch({
                changes: { from: cutRange.from, to: cutRange.to },
                selection: { anchor: cutRange.from },
                userEvent: 'delete.cut',
              });
          })
          .catch(ports.report);
      },
    },
    {
      id: 'md-copy',
      label: t('md.selection.copy'),
      disabled: !target.text,
      shortcut: systemKey(view, 'C'),
      run: () => {
        write(target.text);
      },
    },
    {
      id: 'md-paste',
      label: t('md.selection.paste'),
      disabled: !editable,
      shortcut: systemKey(view, 'V'),
      run: () => {
        if (editable && restore()) void ports.paste().catch(ports.report);
      },
    },
    {
      id: 'md-copyAs',
      label: t('md.selection.copyAs'),
      disabled: empty,
      submenu: [
        {
          id: 'md-copyMarkdown',
          label: t('md.selection.markdown'),
          run: () => {
            write(target.text);
          },
        },
        {
          id: 'md-copyHtml',
          label: t('md.selection.html'),
          run: () => {
            write(markdownToHtml(target.text));
          },
        },
      ],
    },
    {
      id: 'md-selectAll',
      label: t('md.selection.selectAll'),
      shortcut: systemKey(view, 'A'),
      run: () => {
        if (restore()) selectAll(view);
      },
    },
  ];
  if (editable) {
    if (!area)
      items.push(
        {
          id: 'md-format',
          label: t('md.selection.format'),
          submenu: inline.map((c) => fn(c, true)),
        },
        {
          id: 'md-paragraph',
          label: t('md.selection.paragraph'),
          submenu: blocks.map((c) => fn(c, true)),
        },
        {
          id: 'md-insert',
          label: t('md.selection.insert'),
          submenu: (slashGroups(snapshot, '').find((g) => g.section === 'insert')?.items ?? []).map(
            insertEntry,
          ),
        },
      );
    items.push({
      id: 'md-lines',
      label: t('md.selection.line'),
      submenu: [
        {
          id: 'md-undo',
          label: t('md.edit.undo'),
          disabled: undoDepth(initial) === 0,
          shortcut: systemKey(view, 'Z'),
          run: edit(undo),
        },
        {
          id: 'md-redo',
          label: t('md.edit.redo'),
          disabled: redoDepth(initial) === 0,
          run: edit(redo),
        },
        {
          id: 'md-duplicate',
          label: t('md.selection.duplicate'),
          run: edit((v) => {
            if (empty) {
              copyLineDown(v);
              return;
            }
            v.dispatch({
              changes: { from: r.to, insert: target.text },
              selection: EditorSelection.range(r.to, r.to + target.text.length),
              userEvent: 'input.duplicate',
            });
          }),
        },
        ...(
          [
            ['up', moveLineUp],
            ['down', moveLineDown],
            ['indent', indentMore],
            ['outdent', indentLess],
            ['deleteLine', deleteLine],
          ] as const
        ).map(([id, command]) => ({
          id: 'md-' + id,
          label: t(`md.selection.${id}`),
          run: edit(command),
        })),
        ...(['before', 'after'] as const).map((id) => ({
          id: 'md-' + id,
          label: t(`md.selection.${id}`),
          run: edit((v) => {
            const offset = id === 'before' ? first.from : last.to;
            v.dispatch({
              changes: { from: offset, insert: '\n\n' },
              selection: { anchor: offset + (id === 'after' ? 2 : 0) },
              userEvent: 'input.paragraph',
            });
          }),
        })),
      ],
    });
  }
  if (area?.name === 'FencedCode' || area?.name === 'CodeBlock') {
    const opening = doc.lineAt(area.from),
      closing = doc.lineAt(area.to);
    const closed = closing.number > opening.number && /^\s*(?:`{3,}|~{3,})\s*$/u.test(closing.text);
    const content =
      area.name === 'CodeBlock'
        ? initial.sliceDoc(area.from, area.to)
        : initial.sliceDoc(
            Math.min(opening.to + 1, area.to),
            Math.max(opening.to + 1, closed ? closing.from - 1 : area.to),
          );
    items.push({
      id: 'md-copyCode',
      label: t('md.selection.copyCode'),
      disabled: !content,
      run: () => {
        write(content);
      },
    });
  }
  return [...items, ...snippet];
}
function systemKey(v: EditorView, key: string) {
  return (
    (/Mac|iPhone|iPad/u.test(v.dom.ownerDocument.defaultView?.navigator.platform ?? '')
      ? '⌘'
      : 'Ctrl+') + key
  );
}

export function markdownBodyActions(
  eventPath: EventTarget[],
  point: { x: number; y: number },
  keyboard: boolean,
  lines: readonly string[],
  ports: MarkdownMenuPorts,
): MenuItem[] | undefined {
  const elements = eventPath.filter((n): n is HTMLElement => 'nodeType' in n && n.nodeType === 1);
  const content = elements.find((e) => e.classList.contains('cm-content'));
  if (content) {
    if (elements.some((e) => e.matches('input,textarea,select,.md-live-table,[data-table-editor]')))
      return undefined;
    const view = EditorView.findFromDOM(content);
    if (view) {
      const at = keyboard ? view.state.selection.main.head : view.posAtCoords(point, false);
      const result = editorBodyActions(view, at, ports);
      const media = mediaContextItem(elements[0] ?? content, view, at, ports.t);
      return media ? [media, ...result] : result;
    }
  }
  const reader = elements.find((el) => el.classList.contains('markdown-reader'));
  if (!reader) return undefined;
  const selected = reader.ownerDocument.getSelection(),
    target = elements[0];
  const r =
    selected?.rangeCount === 1 &&
    selected.toString() &&
    reader.contains(selected.anchorNode) &&
    reader.contains(selected.focusNode)
      ? selected.getRangeAt(0).cloneRange()
      : undefined;
  const elementOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement);
  const start = (r ? elementOf(r.startContainer) : target)?.closest<HTMLElement>('[data-doc-line]'),
    end = (r ? elementOf(r.endContainer) : target)?.closest<HTMLElement>('[data-end-line]');
  const line = Number(start?.dataset.docLine ?? 1),
    endLine = Number(end?.dataset.endLine ?? line);
  const selectionText = r?.toString() ?? '';
  const value: FileSelection = (r ? readerRange(r, lines) : undefined) ?? {
    text: start ? lines.slice(line - 1, endLine).join('\n') : '',
    startLine: line,
    endLine,
  };
  const link = target?.closest<HTMLElement>('a[href],button[data-file-path]'),
    href = link?.getAttribute('href') ?? link?.dataset.filePath;
  const copy = (value: string) => {
    void ports.copy(value).catch(ports.report);
  };
  const source = target?.closest('pre')?.textContent;
  const media = target ? mediaContextItem(target, null, 0, ports.t) : undefined;
  return [
    ...(media ? [media] : []),
    ...(href && link
      ? [
          {
            id: 'md-openLink',
            label: ports.t('md.selection.openLink'),
            run: () => {
              link.click();
            },
          },
          {
            id: 'md-copyLink',
            label: ports.t('md.selection.copyLink'),
            run: () => {
              copy(href);
            },
          },
        ]
      : []),
    {
      id: 'md-copy',
      label: ports.t('md.selection.copy'),
      disabled: !selectionText,
      run: () => {
        copy(selectionText);
      },
    },
    {
      id: 'md-copyAs',
      label: ports.t('md.selection.copyAs'),
      disabled: !r,
      submenu: [
        {
          id: 'md-copyMarkdown',
          label: ports.t('md.selection.markdown'),
          run: () => {
            if (r) copy(selectionMarkup(r, 'markdown'));
          },
        },
        {
          id: 'md-copyHtml',
          label: ports.t('md.selection.html'),
          run: () => {
            if (r) copy(selectionMarkup(r, 'html'));
          },
        },
      ],
    },
    {
      id: 'md-selectAll',
      label: ports.t('md.selection.selectAll'),
      run: () => {
        const range = reader.ownerDocument.createRange();
        range.selectNodeContents(reader.querySelector('article') ?? reader);
        selected?.removeAllRanges();
        selected?.addRange(range);
      },
    },
    ...(source
      ? [
          {
            id: 'md-copyCode',
            label: ports.t('md.selection.copyCode'),
            run: () => {
              copy(source);
            },
          },
        ]
      : []),
    {
      id: 'md-attach',
      label: ports.t('files.viewer.attachSelection'),
      disabled: !value.text,
      run: () => {
        ports.attach(value);
      },
    },
    {
      id: 'md-comment',
      label: ports.t('files.viewer.comment'),
      disabled: !value.text,
      run: () => {
        ports.comment(value);
      },
    },
  ];
}
export function openMarkdownAddress(
  address: string,
  id: string,
  root: string,
  path: string,
  report: (e: unknown) => void,
) {
  const url = safeHref(address);
  if (url) {
    void window.piarc.openExternal(url).catch(report);
    return;
  }
  const target = fileLocation(
    address.startsWith('#L') ? path + address : address,
    root,
    address.startsWith('#L') ? '' : parentPath(path),
  );
  if (target) openProjectFile(id, target);
}
