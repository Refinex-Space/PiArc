// Shortcuts of the preview that the workbench runs (`preview.pick` Mod+Shift+S, `preview.annotate`
// Mod+Shift+X): the shell shows the preview tool and hands the command to the session's panel,
// which may mount only after the tool opens.
import type { BrowserContextItem } from '../composer/browser-context.js';
import type {
  BrowserElementContext,
  BrowserPick,
  BrowserSourceLocation,
} from '../../shared/browser.js';
import { elementItem } from './context-items.js';

export type PreviewCommand = 'pick' | 'annotate';

const pending = new Map<string, PreviewCommand>();
const listeners = new Map<string, (command: PreviewCommand) => void>();

export function requestPreviewCommand(sessionId: string, command: PreviewCommand): void {
  const listener = listeners.get(sessionId);
  if (listener === undefined) pending.set(sessionId, command);
  else listener(command);
}

export function onPreviewCommand(
  sessionId: string,
  listener: (command: PreviewCommand) => void,
): () => void {
  listeners.set(sessionId, listener);
  const waiting = pending.get(sessionId);
  if (waiting !== undefined) {
    pending.delete(sessionId);
    listener(waiting);
  }
  return () => {
    if (listeners.get(sessionId) === listener) listeners.delete(sessionId);
  };
}

/** `context` with `source` in place of its own (none when `undefined`). */
function withSource(
  context: BrowserElementContext,
  source: BrowserSourceLocation | undefined,
): BrowserElementContext {
  return {
    url: context.url,
    tag: context.tag,
    selector: context.selector,
    xpath: context.xpath,
    role: context.role,
    name: context.name,
    attributes: context.attributes,
    text: context.text,
    html: context.html,
    styles: context.styles,
    box: context.box,
    components: context.components,
    ...(source === undefined ? {} : { source }),
  };
}

/** A path for comparing: `/` separators, no trailing one, lower case on Windows. */
function comparable(value: string, windows: boolean): string {
  const path = value.replaceAll('\\', '/').replace(/\/+$/u, '');
  return windows ? path.toLowerCase() : path;
}

/**
 * A pick as the session sees it: the main process gives the source relative to the workspace;
 * a worktree session's files are under its worktree, so the path is made relative to that, and
 * a source outside the session's file root is dropped (B3.2: then only the component shows).
 */
export function scopeSource(pick: BrowserPick, workspace: string, root: string): BrowserPick {
  const source = pick.context.source;
  if (source === undefined || root === '' || root === workspace) return pick;
  const windows = /^[a-z]:[\\/]/iu.test(workspace);
  const base = comparable(workspace, windows);
  const own = comparable(root, windows);
  if (own === base) return pick;
  const below = own.startsWith(`${base}/`) ? `${own.slice(base.length + 1)}/` : undefined;
  const inside = below !== undefined && comparable(source.path, windows).startsWith(below);
  const scoped = inside ? { ...source, path: source.path.slice(below.length) } : undefined;
  return { ...pick, context: withSource(pick.context, scoped) };
}

/** The items of the tray's cards, numbered in order. */
export function trayItems(
  cards: readonly { readonly pick: BrowserPick; readonly comment: string }[],
): BrowserContextItem[] {
  return cards.map((card, index) => elementItem(index + 1, card.pick, card.comment));
}
