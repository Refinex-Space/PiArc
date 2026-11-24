// The workbench cannot read the clipboard. A native paste requires a physical activation
// of the Paste row and the same editable Markdown document to regain focus. The receipt
// lives in an isolated world and is consumed before Electron dispatches the paste event.
import type { WebContents } from 'electron';
const PASTE_WORLD = 1007;
const observe = `() => {
  if(globalThis.observingMarkdownMenus)return true;
  globalThis.observingMarkdownMenus=true;
  const begin=e=>{
    if(!e.isTrusted)return;
    if(e.type==='keydown' && !(e.key==='ContextMenu'||(e.key==='F10'&&e.shiftKey)))return;
    const editor=e.composedPath().find(n=>n instanceof Element && n.matches('.cm-content[contenteditable="true"][aria-readonly="false"]'));
    const host=editor?.getRootNode().host?.closest('.file-viewer[data-md-session]');
    globalThis.pasteMenu=host ? {editor,host,session:host.dataset.mdSession,path:host.getAttribute('aria-label'),opened:performance.now(),at:null}:null;
  };
  const choose=e=>{
    const grant=globalThis.pasteMenu;
    if(!grant || !e.isTrusted || (e.type==='click'?e.button!==0:(e.repeat||!['Enter',' '].includes(e.key))))return;
    const el=e.composedPath().find(n=>n instanceof Element);
    const row=e.type==='click'?el?.closest('[role=menuitem]'):document.getElementById(el?.closest('[role=menu]')?.getAttribute('aria-activedescendant')??'');
    if(row?.dataset.testid==='menu-md-paste' && row.getClientRects().length && row.getAttribute('aria-disabled')!=='true')grant.at=performance.now();
    else globalThis.pasteMenu=null;
  };
  window.addEventListener('contextmenu',begin,true);
  window.addEventListener('keydown',begin,true);
  window.addEventListener('keydown',choose,true);
  window.addEventListener('click',choose,true);
  window.addEventListener('blur',()=>{globalThis.pasteMenu=null;});
  return true;
}`;
const consume = `(session,path)=>{
  const grant=globalThis.pasteMenu;
  globalThis.pasteMenu=null;
  if(!grant || grant.session!==session || grant.path!==path)return false;
  const el=grant.editor,now=performance.now();
  return now-grant.opened<120000 && grant.at!==null && now-grant.at<1500 && document.hasFocus()
    && el.isConnected && el.isContentEditable && el.getAttribute('aria-readonly')==='false'
    && el.getRootNode().activeElement===el && document.activeElement===el.getRootNode().host
    && grant.host.dataset.mdSession===session && grant.host.getAttribute('aria-label')===path
    && el.getClientRects().length>0;
}`;

export async function markdownPaste(
  action: 'observeMarkdownPaste' | 'pasteMarkdown',
  session: string,
  path: string,
  sender: WebContents,
  focused: () => WebContents | undefined,
  owner: (contents: WebContents) => WebContents | undefined,
): Promise<string> {
  const window = focused();
  if (
    !window ||
    window.isDestroyed() ||
    (window !== sender && owner(window) !== sender) ||
    window.focusedFrame !== window.mainFrame
  )
    throw new Error('Markdown editor is not focused');
  const code =
    action === 'observeMarkdownPaste'
      ? '(' + observe + ')()'
      : '(' + consume + ')(' + JSON.stringify(session) + ',' + JSON.stringify(path) + ')';
  const accepted: unknown = await window.executeJavaScriptInIsolatedWorld(PASTE_WORLD, [{ code }]);
  if (
    accepted !== true ||
    window !== focused() ||
    window.isDestroyed() ||
    window.focusedFrame !== window.mainFrame
  )
    throw new Error('The Markdown paste gesture has expired');
  if (action === 'pasteMarkdown') window.paste();
  return '{}';
}
