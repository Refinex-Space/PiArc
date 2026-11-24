// The editor menu's "View image / View diagram" comes from Markdown Studio e6ebd0c,
// web/core/features/viewers/markdown/livePreview/actions.ts (Apache-2.0).
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { AppContextValue } from '../../app/app-context.js';
import type { MenuItem } from '../../shell/Menu.js';

export type SourceMedia =
  { kind: 'image'; source: string; label: string } | { kind: 'diagram'; source: string };
type Focus = () => void;
type OpenSource = (item: SourceMedia, restore: Focus) => void;
interface Thumbnail {
  kind: SourceMedia['kind'];
  open: (restore?: Focus) => void;
}
const workspaces = new WeakMap<Element, OpenSource>(),
  thumbnails = new WeakMap<Element, Thumbnail>();
export function bindMediaContext(root: Element, display: OpenSource) {
  workspaces.set(root, display);
  return () => {
    if (workspaces.get(root) === display) workspaces.delete(root);
  };
}
export function bindMediaThumbnail(root: Element, entry: Thumbnail) {
  thumbnails.set(root, entry);
  return () => {
    if (thumbnails.get(root) === entry) thumbnails.delete(root);
  };
}
function text(state: EditorState, n: SyntaxNode | null) {
  return n ? state.sliceDoc(n.from, n.to) : '';
}
function referenceUrl(state: EditorState, label: string) {
  const normalize = (v: string) => v.trim().replace(/\s+/gu, ' ').toLowerCase();
  const wanted = normalize(label);
  let found = '';
  syntaxTree(state).iterate({
    enter(ref) {
      if (found) return false;
      if (ref.name === 'LinkReference') {
        const node = ref.node,
          name = text(state, node.getChild('LinkLabel')).slice(1, -1);
        if (normalize(name) === wanted) found = text(state, node.getChild('URL'));
        return false;
      }
      return undefined;
    },
  });
  return found;
}
export function mediaAtSource(state: EditorState, at: number): SourceMedia | undefined {
  const pos = Math.max(0, Math.min(state.doc.length, at));
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'FencedCode') {
        const language = text(state, n.getChild('CodeInfo')).trim().toLowerCase(),
          source = text(state, n.getChild('CodeText'));
        if (language === 'mermaid' && source.trim()) return { kind: 'diagram', source };
        break;
      }
      if (n.name !== 'Image') continue;
      const [first, last] = n.getChildren('LinkMark');
      const label = first && last ? state.sliceDoc(first.to, last.from) : '';
      const src =
        text(state, n.getChild('URL')) ||
        referenceUrl(state, text(state, n.getChild('LinkLabel')).slice(1, -1) || label);
      const source = src.replace(/^<|>$/gu, '').replace(/\\([\\()[\]<> ])/gu, '$1');
      if (
        source &&
        !source.startsWith('//') &&
        !source.startsWith('\\\\') &&
        !/[\r\n]/u.test(source) &&
        (!/^[a-z][a-z0-9+.-]*:/iu.test(source) || /^file:\/\/\//iu.test(source))
      )
        return { kind: 'image', source, label };
      break;
    }
  }
  return undefined;
}
/** Capture the exact clicked thumbnail or CM document. A stale menu cannot open a media
 * item after a tab change, a source edit or a native tool window transition. */
export function mediaContextItem(
  origin: HTMLElement,
  view: EditorView | null,
  at: number,
  t: AppContextValue['t'],
): MenuItem | undefined {
  const node = origin.closest('.md-media-thumb'),
    thumbnail = node ? thumbnails.get(node) : undefined;
  if (node && thumbnail)
    return {
      id: 'view-media',
      label: t(thumbnail.kind === 'image' ? 'files.media.viewImage' : 'files.media.viewDiagram'),
      run: () => {
        if (node.isConnected && thumbnails.get(node) === thumbnail)
          thumbnail.open(
            view
              ? () => {
                  view.focus();
                }
              : undefined,
          );
      },
    };
  if (!view) return undefined;
  const containing = view.dom.getRootNode();
  const host = 'host' in containing ? (containing as ShadowRoot).host : null;
  const scope = view.dom.closest('.markdown-workspace') ?? host?.closest('.markdown-workspace');
  const service = scope && workspaces.get(scope),
    doc = view.state.doc,
    item = mediaAtSource(view.state, at);
  if (!scope || !service || !item) return undefined;
  return {
    id: 'view-media',
    label: t(item.kind === 'image' ? 'files.media.viewImage' : 'files.media.viewDiagram'),
    run: () => {
      if (
        scope.isConnected &&
        view.dom.isConnected &&
        view.state.doc === doc &&
        workspaces.get(scope) === service
      )
        service(item, () => {
          view.focus();
        });
    },
  };
}
