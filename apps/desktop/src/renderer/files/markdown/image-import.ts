// An image import may take longer than the user's next edit. Keep each insertion range
// in the editor transaction stream. A replaced selection or a reload invalidates that target.
import { Annotation, Facet, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
interface ImageTarget {
  from: number;
  to: number;
}
const set = StateEffect.define<{ id: number; target: ImageTarget | null }>();
export const externalReload = Annotation.define<boolean>();
export const imageTargets = StateField.define<ReadonlyMap<number, ImageTarget>>({
  create: () => new Map(),
  update(value, tr) {
    if (tr.annotation(externalReload)) return new Map();
    if (!tr.docChanged && !tr.effects.length) return value;
    const next = new Map<number, ImageTarget>();
    for (const [key, r] of value) {
      const from = tr.changes.mapPos(r.from, 1),
        to = r.from === r.to ? from : tr.changes.mapPos(r.to, -1);
      if (
        !tr.changes.touchesRange(r.from, r.to) ||
        r.from === r.to ||
        (to >= from && tr.startState.sliceDoc(r.from, r.to) === tr.newDoc.sliceString(from, to))
      )
        next.set(key, { from, to });
    }
    for (const e of tr.effects)
      if (e.is(set)) {
        if (e.value.target) next.set(e.value.id, e.value.target);
        else next.delete(e.value.id);
      }
    return next;
  },
});
type ImageImporter = (files: readonly File[]) => Promise<readonly string[]>;
interface ImagePort {
  importImages?: ImageImporter;
  error: (e: unknown) => void;
  view: () => EditorView | undefined;
  chooseImage?: (state: EditorState, target: ImageTarget) => Promise<string | null>;
}
export const imagePort = Facet.define<() => ImagePort>();
let serial = 0;
export async function insertImages(
  view: EditorView,
  files?: readonly File[],
  at: ImageTarget = view.state.selection.main,
) {
  const port = view.state.facet(imagePort)[0]?.();
  const request =
    files?.length && port?.importImages
      ? () => port.importImages?.(files)
      : files === undefined && port?.chooseImage
        ? async () => {
            const markdown = await port.chooseImage?.(view.state, at);
            return markdown ? [markdown] : [];
          }
        : undefined;
  if (!port || !request || view.state.readOnly) return;
  const id = ++serial;
  view.dispatch({ effects: set.of({ id, target: at }) });
  try {
    const markdown = await request();
    const current = port.view();
    if (!current || current.state.readOnly || !markdown?.length) return;
    const target = current.state.field(imageTargets).get(id);
    if (!target) return;
    const insert = markdown.join('\n');
    const follow =
      current.state.selection.main.from === target.from &&
      current.state.selection.main.to === target.to;
    current.dispatch({
      changes: { ...target, insert },
      ...(follow ? { selection: { anchor: target.from + insert.length } } : {}),
      userEvent: 'input.image',
      scrollIntoView: follow,
    });
  } catch (error) {
    if (port.view()) port.error(error);
  } finally {
    port.view()?.dispatch({ effects: set.of({ id, target: null }) });
  }
}
export function imageFiles(data: DataTransfer | null) {
  return Array.from(data?.files ?? []).filter(
    (f) =>
      f.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/iu.test(f.name),
  );
}
export const imageInput = EditorView.domEventHandlers({
  paste: (e, v) => dropImages(e, v, e.clipboardData),
  drop: (e, v) => dropImages(e, v, e.dataTransfer, v.posAtCoords({ x: e.clientX, y: e.clientY })),
});
function dropImages(e: Event, v: EditorView, data: DataTransfer | null, pos?: number | null) {
  if (!v.state.facet(imagePort)[0]?.().importImages || v.state.readOnly) return false;
  const files = imageFiles(data);
  if (!files.length) return false;
  e.preventDefault();
  void insertImages(v, files, pos != null ? { from: pos, to: pos } : v.state.selection.main);
  return true;
}
