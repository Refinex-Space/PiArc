// The agent's cursor and action label on a page (design addendum B2.5.1): while a script acts,
// the user sees where it points and what it is doing. Drawn from an isolated world (the page's
// scripts share the DOM but not this code) into a closed shadow root with
// `pointer-events: none`, so it never takes a click and the page cannot read its text.

import type { WebContents } from 'electron';

/** The isolated world the cursor is drawn from (any id but 0, the page's own world). */
const CURSOR_WORLD = 7301;

function cursorScript(x: number, y: number, label: string | undefined): string {
  const args = JSON.stringify({ x, y, label: label ?? '' });
  return `(() => {
  const { x, y, label } = ${args};
  const KEY = '__piarcAgentCursor';
  let state = globalThis[KEY];
  if (!state || !state.host.isConnected) {
    const host = document.createElement('piarc-agent-cursor');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
    const root = host.attachShadow({ mode: 'closed' });
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(59,130,246,0.35);border:2px solid rgb(59,130,246);box-shadow:0 0 0 4px rgba(59,130,246,0.18);' +
      'transition:left 220ms ease-out,top 220ms ease-out;';
    const tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;transform:translate(14px,10px);max-width:280px;padding:3px 8px;' +
      'border-radius:6px;background:rgb(30,41,59);color:#fff;font:12px/1.4 system-ui,sans-serif;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:left 220ms ease-out,top 220ms ease-out;';
    root.append(dot, tag);
    (document.documentElement || document.body).append(host);
    state = { host, dot, tag, timer: 0 };
    globalThis[KEY] = state;
  }
  state.dot.style.left = x + 'px';
  state.dot.style.top = y + 'px';
  state.tag.style.left = x + 'px';
  state.tag.style.top = y + 'px';
  state.tag.textContent = label;
  state.tag.style.display = label ? 'block' : 'none';
  state.host.style.opacity = '1';
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { state.host.style.opacity = '0'; }, 2500);
})();`;
}

/** Moves the agent's cursor in `contents` to `x`, `y` (CSS pixels) with `label`. */
export function showCursor(
  contents: WebContents,
  x: number,
  y: number,
  label: string | undefined,
): void {
  if (contents.isDestroyed()) return;
  contents
    .executeJavaScriptInIsolatedWorld(CURSOR_WORLD, [{ code: cursorScript(x, y, label) }])
    .catch(() => {
      // The page is between documents: the next action draws it again.
    });
}
