// Widgets are painted by the parent React tree so images and rich blocks retain the
// current session's permissions, theme and document preview services.
import { Facet, type EditorState } from '@codemirror/state';
import { WidgetType, type EditorView } from '@codemirror/view';
import type { AppContextValue } from '../../app/app-context.js';

export type WidgetContent =
  | { kind: 'math' | 'mermaid'; source: string; inline: boolean }
  | { kind: 'image'; source: string; alt: string; inline: true };
export interface WidgetHost {
  t: AppContextValue['t'];
  mount: (el: HTMLElement, content: WidgetContent) => void;
  unmount: (el: HTMLElement) => void;
}
export const widgetHost = Facet.define<WidgetHost, WidgetHost | undefined>({
  combine: (values) => values[0],
});
export function hostOf(state: EditorState) {
  const host = state.facet(widgetHost);
  if (!host) throw new Error('Missing markdown widget host');
  return host;
}
export class RichWidget extends WidgetType {
  constructor(readonly content: WidgetContent) {
    super();
  }
  override eq(other: RichWidget) {
    const c = this.content,
      b = other.content;
    return (
      c.kind === b.kind &&
      c.inline === b.inline &&
      c.source === b.source &&
      (c.kind !== 'image' || (b.kind === 'image' && c.alt === b.alt))
    );
  }
  toDOM(view: EditorView) {
    const el = view.dom.ownerDocument.createElement(this.content.inline ? 'span' : 'div');
    el.className = 'md-rich-widget';
    el.contentEditable = 'false';
    const host = hostOf(view.state);
    host.mount(el, this.content);
    mountedReleases.set(el, () => {
      host.unmount(el);
    });
    return el;
  }
  override destroy(el: HTMLElement) {
    this.cleanup(el);
  }
  private cleanup(el: HTMLElement) {
    mountedReleases.get(el)?.();
    mountedReleases.delete(el);
  }
  override ignoreEvent(event: Event) {
    // Buttons within the React widget (for example an image zoom) keep their own pointer and keyboard gestures.
    const node = event.target as Element | null;
    return (
      typeof node?.closest === 'function' && node.closest('button,a,input,[role=dialog]') !== null
    );
  }
}
const mountedReleases = new WeakMap<HTMLElement, () => void>();
