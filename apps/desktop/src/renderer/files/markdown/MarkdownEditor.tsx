import type { ImagePlacement } from '../../../shared/markdown-images.js';
import { history, undo, redo, undoDepth, redoDepth, isolateHistory } from '@codemirror/commands';
import { openSearchPanel, search } from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  type Extension,
  Transaction,
} from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  tooltips,
} from '@codemirror/view';
import { createPortal } from 'react-dom';
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { useApp } from '../../app/app-context.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { reason } from '../../shell/errors.js';
import type { FileSelection, FindMatch, ViewerSettings } from '../viewer-model.js';
import type { FileLocation } from '../viewer-source.js';
import { EditorToolbar } from './EditorToolbar.js';
import { applyFormat, type FormatCommand } from './formatting.js';
import { editSettings } from './editor-settings.js';
import { editorHighlight, editorTheme } from './editor-theme.js';
import {
  externalReload,
  imageInput,
  imagePort,
  imageTargets,
  insertImages,
} from './image-import.js';
import { markdownSupport } from './language.js';
import {
  applySourceTableAction,
  tableAtCursor,
  cellSelection,
  forgetTableSelection,
} from './live-table.js';
import { slashMenu } from './slash-menu.js';
import { selectionTools } from './selection-tools.js';
import { fenceLanguages } from './fence-language.js';
import { liveExtensions } from './live-preview.js';
import { widgetHost, type WidgetContent } from './widget-host.js';

export interface MarkdownEditorHandle {
  focus: () => void;
  findReplace: () => void;
  scrollToLine: (line: number) => void;
  applyUserChange: (next: string) => void;
}
export interface MarkdownEditorProps {
  sessionId: string;
  path: string;
  mode: 'live' | 'source';
  text: string;
  settings: ViewerSettings;
  editable?: boolean;
  visible?: boolean;
  location?: FileLocation | undefined;
  match?: FindMatch | undefined;
  onChange: (value: string) => void;
  onSelect: (s: FileSelection | undefined) => void;
  onScrollLine?: (line: number) => void;
  importImages?: (files: readonly File[]) => Promise<readonly string[]>;
  chooseImage?: (placement: ImagePlacement) => Promise<string | null>;
  onImageSettings?: () => void;
  renderImage?: (src: string, alt: string) => ReactNode;
  followLink?: (href: string) => void;
  renderBlock?: (kind: 'math' | 'mermaid', source: string, inline: boolean) => ReactNode;
  ref?: Ref<MarkdownEditorHandle>;
}
interface WidgetItem {
  el: HTMLElement;
  content: WidgetContent;
  key: number;
}
interface Runtime {
  view: EditorView;
  settings: Compartment;
}
export function applyUserChange(view: EditorView, value: string) {
  if (view.state.readOnly || view.composing) return;
  const src = view.state.doc.toString(),
    next = value.replace(/\r\n|\r/gu, '\n');
  if (src === next) return;
  let from = 0,
    end = src.length,
    target = next.length;
  while (from < end && from < target && src.charCodeAt(from) === next.charCodeAt(from)) from++;
  while (end > from && target > from && src.charCodeAt(end - 1) === next.charCodeAt(target - 1)) {
    end--;
    target--;
  }
  view.dispatch({
    changes: { from, to: end, insert: next.slice(from, target) },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.task',
  });
}
function clampLine(s: EditorState, n: number) {
  return s.doc.line(Math.max(1, Math.min(n, s.doc.lines)));
}
function selectedText(state: EditorState): FileSelection | undefined {
  const range = state.selection.main;
  if (range.empty) return undefined;
  return {
    startLine: state.doc.lineAt(range.from).number,
    endLine: state.doc.lineAt(Math.max(range.from, range.to - 1)).number,
    text: state.sliceDoc(range.from, range.to),
  };
}

/** CodeMirror offsets count each newline once. Replay actual edits against the raw
 * source so opening, formatting elsewhere or toggling mode leaves untouched CRLFs intact. */
function sourcePositions(raw: string, state: EditorState) {
  const endings = Array.from(raw.matchAll(/\r\n|\r|\n/gu));
  return {
    offset(pos: number) {
      const line = state.doc.lineAt(pos),
        previous = endings[line.number - 2];
      return (previous ? previous.index + previous[0].length : 0) + pos - line.from;
    },
    eol(pos: number): ImagePlacement['eol'] {
      const line = state.doc.lineAt(pos).number;
      const ending = endings[line - 1]?.[0] ?? endings[line - 2]?.[0];
      return ending === '\r' || ending === '\r\n' ? ending : '\n';
    },
  };
}
export function patchSource(raw: string, tr: Transaction) {
  if (!raw.includes('\r')) return tr.newDoc.toString();
  const positions = sourcePositions(raw, tr.startState);
  let result = '',
    prev = 0;
  tr.changes.iterChanges((from, to, _a, _b, insert) => {
    result +=
      raw.slice(prev, positions.offset(from)) +
      insert.sliceString(0, insert.length, positions.eol(from));
    prev = positions.offset(to);
  });
  return result + raw.slice(prev);
}
export function MarkdownEditor(props: MarkdownEditorProps) {
  const doc = useSurfaceDocument(),
    app = useApp(),
    { t } = app;
  const callbacks = useRef(props);
  callbacks.current = props;
  const translate = useRef(t);
  translate.current = t;
  const host = useRef<HTMLDivElement>(null),
    runtime = useRef<Runtime | null>(null);
  const remembered = useRef<
    | {
        state: EditorState;
        scroll: ReturnType<EditorView['scrollSnapshot']>;
        raw: string;
        settings: Compartment;
        sessionId: string;
        path: string;
      }
    | undefined
  >(undefined);
  const raw = useRef(props.text);
  const [sourceTableActive, setSourceTableActive] = useState(false);
  const [historyState, setHistoryState] = useState({ undo: false, redo: false });
  const [widgets, setWidgets] = useState<readonly WidgetItem[]>([]);
  const [error, setError] = useState('');
  const suppress = useRef(0);
  const {
    mode,
    settings,
    editable = true,
    visible = true,
    location,
    match,
    text,
    sessionId,
    path,
  } = props;
  const showFind = () => {
    if (runtime.current) openSearchPanel(runtime.current.view);
  };
  const scrollToLine = (n: number) => {
    const view = runtime.current?.view;
    if (!view || !host.current?.clientHeight) return;
    suppress.current = performance.now() + 150;
    view.dispatch({
      effects: EditorView.scrollIntoView(clampLine(view.state, n).from, { y: 'start', yMargin: 0 }),
    });
  };
  useImperativeHandle(props.ref, () => ({
    focus: () => {
      runtime.current?.view.focus();
    },
    findReplace: showFind,
    applyUserChange: (value: string) => {
      if (runtime.current) applyUserChange(runtime.current.view, value);
    },
    scrollToLine,
  }));
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    // Constructed style sheets must be created in this document. Rebuilding only the DOM on
    // adoption retains the state, history and selection when the tile docks or pops out.
    const mount = doc.createElement('div');
    mount.className = 'md-editor-mount';
    container.append(mount);
    const shadow = mount.attachShadow({ mode: 'open' });
    const viewport = doc.createElement('div');
    viewport.style.cssText = 'height:100%;min-height:0';
    shadow.append(viewport);
    for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')) {
      const copy = doc.createElement('link');
      copy.rel = 'stylesheet';
      copy.href = link.href;
      shadow.prepend(copy);
    }
    setWidgets([]);
    let alive = true,
      scheduled = false,
      sequence = 0;
    const portals = new Map<HTMLElement, WidgetItem>();
    const updateWidgets = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (alive) setWidgets([...portals.values()]);
      });
    };
    const reuse =
      remembered.current?.sessionId === sessionId &&
      remembered.current.path === path &&
      remembered.current.raw === callbacks.current.text
        ? remembered.current
        : undefined;
    const presentation = reuse?.settings ?? new Compartment();
    // Live widgets and input callbacks always address the current view, even after DOM adoption.
    const transport = new Compartment();
    const bindings = (): Extension => [
      imagePort.of(() => ({
        ...(callbacks.current.importImages ? { importImages: callbacks.current.importImages } : {}),
        ...(callbacks.current.chooseImage
          ? {
              chooseImage: (state: EditorState, target: { from: number; to: number }) => {
                const text = raw.current,
                  positions = sourcePositions(text, state);
                return (
                  callbacks.current.chooseImage?.({
                    text,
                    from: positions.offset(target.from),
                    to: positions.offset(target.to),
                    eol: positions.eol(target.from),
                  }) ?? Promise.resolve(null)
                );
              },
            }
          : {}),
        view: () =>
          callbacks.current.sessionId === sessionId && callbacks.current.path === path
            ? runtime.current?.view
            : undefined,
        error: (e: unknown) => {
          setError(translate.current('md.edit.failedImage', { reason: reason(e) }));
        },
      })),
      widgetHost.of({
        t: (id, values) => translate.current(id, values),
        mount: (el, content) => {
          portals.set(el, { el, content, key: ++sequence });
          updateWidgets();
        },
        unmount: (el) => {
          portals.delete(el);
          updateWidgets();
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(externalReload))) {
          for (const tr of u.transactions)
            if (tr.docChanged) raw.current = patchSource(raw.current, tr);
          callbacks.current.onChange(raw.current);
        }
        if (u.selectionSet || u.docChanged) {
          callbacks.current.onSelect(selectedText(u.state));
          setSourceTableActive(!!tableAtCursor(u.state));
        }
        if (u.docChanged) {
          const a = undoDepth(u.state) > 0,
            b = redoDepth(u.state) > 0;
          setHistoryState((prev) =>
            a === prev.undo && b === prev.redo ? prev : { undo: a, redo: b },
          );
        }
      }),
      EditorView.domEventHandlers({
        focus: (event, v) => {
          if (event.target === v.contentDOM) forgetTableSelection(v);
          return false;
        },
        mousedown: (event, v) => {
          if (
            callbacks.current.mode === 'live' &&
            (event.metaKey || event.ctrlKey) &&
            event.button === 0
          ) {
            const link = (event.target as HTMLElement | null)?.closest<HTMLElement>(
              '.md-live-link',
            );
            if (link?.dataset.href && callbacks.current.followLink) {
              event.preventDefault();
              callbacks.current.followLink(link.dataset.href);
              return true;
            }
          }
          if (event.target === v.contentDOM) forgetTableSelection(v);
          return false;
        },
        scroll: (_event, v) => {
          if (suppress.current > performance.now() || callbacks.current.visible === false)
            return false;
          const y = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
          callbacks.current.onScrollLine?.(
            v.state.doc.lineAt(v.lineBlockAtHeight(Math.max(0, y)).from).number,
          );
          return false;
        },
        contextmenu: (_event, v) => {
          const sel = selectedText(v.state);
          const l = v.state.doc.lineAt(v.state.selection.main.head);
          if (!sel && l.length)
            callbacks.current.onSelect({ startLine: l.number, endLine: l.number, text: l.text });
          return false;
        },
      }),
    ];
    const ext = [
      markdownSupport(),
      editorHighlight,
      editorTheme,
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      history(),
      search({ top: true }),
      tooltips({
        tooltipSpace: (view) => {
          const b = view.dom.getBoundingClientRect();
          const inset = Math.min(8, b.width / 4, b.height / 4);
          return {
            left: b.left + inset,
            right: b.right - inset,
            top: b.top + inset,
            bottom: b.bottom - inset,
          };
        },
      }),
      ...liveExtensions,
      slashMenu,
      selectionTools,
      fenceLanguages,
      imageInput,
      imageTargets,
      transport.of(bindings()),
      presentation.of(
        editSettings(
          callbacks.current.mode,
          callbacks.current.settings,
          callbacks.current.editable !== false,
          translate.current,
        ),
      ),
    ];
    raw.current = callbacks.current.text;
    let state: EditorState;
    if (reuse) {
      state = reuse.state.update({ effects: StateEffect.reconfigure.of(ext) }).state;
    } else state = EditorState.create({ doc: raw.current, extensions: ext });
    const view = new EditorView({ state, parent: viewport, root: shadow });
    if (reuse) view.dispatch({ effects: reuse.scroll });
    runtime.current = { view, settings: presentation };
    setSourceTableActive(!!tableAtCursor(view.state));
    remembered.current = undefined;
    setHistoryState({ undo: undoDepth(view.state) > 0, redo: redoDepth(view.state) > 0 });
    return () => {
      remembered.current = {
        state: view.state,
        scroll: view.scrollSnapshot(),
        raw: raw.current,
        settings: presentation,
        sessionId,
        path,
      };
      alive = false;
      view.destroy();
      portals.clear();
      runtime.current = null;
      mount.remove();
    };
  }, [doc, sessionId, path]);
  useLayoutEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    const shownMode = visible ? mode : 'source';
    const cell = shownMode === 'source' ? cellSelection(rt.view) : undefined;
    if (cell) forgetTableSelection(rt.view);
    rt.view.dispatch({
      ...(cell ? { selection: EditorSelection.single(cell.anchor, cell.head) } : {}),
      effects: rt.settings.reconfigure(editSettings(shownMode, settings, editable, t)),
    });
  }, [mode, settings, editable, t, doc, visible]);
  useLayoutEffect(() => {
    const view = runtime.current?.view;
    if (!view || text === raw.current) return;
    const normalized = text.replace(/\r\n|\r/gu, '\n');
    raw.current = text;
    if (normalized === view.state.doc.toString()) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
      annotations: [externalReload.of(true), Transaction.addToHistory.of(false)],
      selection: EditorSelection.single(
        Math.min(sel.anchor, normalized.length),
        Math.min(sel.head, normalized.length),
      ),
    });
  }, [text]);
  useLayoutEffect(() => {
    const view = runtime.current?.view;
    if (!view || (!match && !location) || !visible) return;
    const line = clampLine(view.state, match?.line ?? location?.line ?? 1);
    const a = Math.min(
      line.to,
      line.from + (match?.start ?? Math.max(0, (location?.column ?? 1) - 1)),
    );
    const b = match
      ? Math.min(line.to, line.from + match.end)
      : location?.endLine
        ? clampLine(view.state, location.endLine).to
        : a;
    view.dispatch({
      selection: EditorSelection.single(a, b),
      effects: EditorView.scrollIntoView(a, { y: 'center' }),
    });
  }, [match, location, visible, doc]);
  useLayoutEffect(() => {
    if (visible) runtime.current?.view.requestMeasure();
  }, [visible, mode, doc]);
  const run = (cmd: FormatCommand) => {
    if (runtime.current) applyFormat(runtime.current.view, cmd, (n) => t('md.edit.column', { n }));
  };
  return (
    <div className="markdown-editor-pane" data-testid="markdown-editor" data-mode={mode}>
      <EditorToolbar
        run={run}
        editable={editable}
        editTable={
          mode === 'source' && sourceTableActive
            ? (a) => {
                if (runtime.current) applySourceTableAction(runtime.current.view, a);
              }
            : undefined
        }
        image={
          props.importImages
            ? (files) => {
                if (runtime.current) void insertImages(runtime.current.view, files);
              }
            : undefined
        }
        choose={
          props.chooseImage
            ? () => {
                if (runtime.current) void insertImages(runtime.current.view);
              }
            : undefined
        }
        configureImages={props.onImageSettings}
        findReplace={showFind}
        undo={() => {
          if (runtime.current) undo(runtime.current.view);
        }}
        redo={() => {
          if (runtime.current) redo(runtime.current.view);
        }}
        canUndo={historyState.undo}
        canRedo={historyState.redo}
      />
      {error && (
        <div role="alert" className="file-viewer-alert">
          {error}
          <button
            onClick={() => {
              setError('');
            }}
          >
            {t('md.edit.close')}
          </button>
        </div>
      )}
      <div className="md-editor-host" ref={host} />
      {widgets.map(({ el, content, key }) =>
        createPortal(
          content.kind === 'image'
            ? (props.renderImage?.(content.source, content.alt) ?? content.alt)
            : (props.renderBlock?.(content.kind, content.source, content.inline) ?? content.source),
          el,
          String(key),
        ),
      )}
    </div>
  );
}
