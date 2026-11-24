// A detached tool stays owned by the original workbench page. Only its scriptless document
// and native window are new. Arbitrary opens, navigations, nested windows and preloads stay off.
import { randomUUID } from 'node:crypto';
import type {
  BrowserWindow,
  HandlerDetails,
  WebContents,
  WindowOpenHandlerResponse,
} from 'electron';
import { APP_EVENT_CHANNEL, IPC_CHANNELS, isSessionId, type AppEvent } from '../shared/ipc.js';
import type { RegisterHandler } from './ipc/register.js';
import type { TerminalOwners } from './core/terminal-ipc.js';
import { secureWebPreferences } from './web-preferences.js';

const TOOLS: ReadonlySet<string> = new Set([
  'terminal',
  'changes',
  'side-chat',
  'background-tasks',
  'preview',
  'files',
  'plan',
]);
const TICKET_TTL = 4000;
interface Ticket {
  readonly token: string;
  readonly owner: WebContents;
  readonly page: number;
  readonly session: string;
  readonly panel: string;
  readonly url: string;
  readonly deadline: number;
}

/** All grants and their lifetimes live in the main process. */
export class ToolWindows {
  readonly #pending = new Map<string, Ticket>();
  readonly #open = new Map<string, { ticket: Ticket; child: BrowserWindow }>();
  readonly #watched = new WeakSet<WebContents>();
  constructor(
    private readonly input: Pick<TerminalOwners, 'page' | 'requireInput' | 'bindToolInput'>,
    private readonly isWorkbench: (sender: WebContents) => boolean,
    private readonly checkSession: (id: string) => Promise<boolean>,
  ) {}

  register(register: RegisterHandler): void {
    register(IPC_CHANNELS.toolWindowPrepare, async (event, [session, panel]) => {
      const { sender, senderFrame } = event;
      if (
        !this.isWorkbench(sender) ||
        senderFrame !== sender.mainFrame ||
        !isSessionId(session) ||
        typeof panel !== 'string' ||
        !TOOLS.has(panel)
      )
        throw new TypeError('Invalid tool window');
      this.input.requireInput(sender);
      const page = this.input.page(sender);
      if (
        !(await this.checkSession(session)) ||
        sender.isDestroyed() ||
        this.input.page(sender) !== page
      )
        throw new Error('Tool session is unavailable');
      const url = new URL('/tool-window.html', sender.getURL()).href;
      this.#watch(sender);
      const now = Date.now();
      for (const [key, old] of this.#pending) {
        if (
          old.deadline < now ||
          (old.owner === sender && old.session === session && old.panel === panel)
        )
          this.#pending.delete(key);
      }
      for (const { ticket } of this.#open.values()) {
        if (ticket.owner === sender && ticket.session === session && ticket.panel === panel)
          throw new Error('Tool window already open');
      }
      const token = randomUUID();
      this.#pending.set(token, {
        token,
        owner: sender,
        page,
        session,
        panel,
        url,
        deadline: now + TICKET_TTL,
      });
      return token;
    });
    register(IPC_CHANNELS.toolWindowPin, ({ sender, senderFrame }, [token, pinned]) => {
      const open = typeof token === 'string' ? this.#open.get(token) : undefined;
      if (
        open?.ticket.owner !== sender ||
        senderFrame !== sender.mainFrame ||
        typeof pinned !== 'boolean' ||
        open.child.isDestroyed()
      )
        throw new TypeError('Invalid tool window');
      open.child.setAlwaysOnTop(pinned);
    });
  }

  allowFileFrame?: (
    contents: WebContents,
    url: string,
    parent?: string,
    initiator?: string,
  ) => boolean;
  fileOwner(contents: WebContents): WebContents | undefined {
    for (const { child, ticket } of this.#open.values())
      if (ticket.panel === 'files' && child.webContents === contents) return ticket.owner;
    return undefined;
  }
  open(sender: WebContents, details: HandlerDetails): WindowOpenHandlerResponse | undefined {
    const ticket = this.#pending.get(details.frameName);
    if (
      ticket?.owner !== sender ||
      ticket.url !== details.url ||
      details.features !== '' ||
      details.postBody
    )
      return undefined;
    this.#pending.delete(ticket.token);
    if (
      Date.now() > ticket.deadline ||
      this.input.page(sender) !== ticket.page ||
      !this.isWorkbench(sender)
    )
      return undefined;
    // did-create-window includes the window Electron constructs with its own openerId. Keeping
    // Chromium's opener relation until the owner attaches the portal enables same-origin DOM access.
    const attach = (child: BrowserWindow, opened: { frameName: string }) => {
      if (opened.frameName !== ticket.token) return;
      sender.removeListener('did-create-window', attach);
      this.#open.set(ticket.token, { ticket, child });
      const contents = child.webContents;
      const unbind =
        ticket.panel === 'terminal' || ticket.panel === 'files'
          ? this.input.bindToolInput(contents, sender, ticket.session, ticket.panel)
          : undefined;
      // The initial load is the single allowed document. Renderer navigation, redirects and
      // frame navigations are never part of the tool-window protocol.
      let initial = true;
      contents.once('did-finish-load', () => {
        initial = false;
      });
      contents.on('will-navigate', (event) => {
        if (!initial || event.url !== ticket.url) event.preventDefault();
      });
      contents.on('will-frame-navigate', (event) => {
        if (
          !event.isMainFrame &&
          ticket.panel === 'files' &&
          this.allowFileFrame?.(contents, event.url, event.frame?.parent?.url, event.initiator?.url)
        )
          return;
        if (!initial || !event.isMainFrame || event.url !== ticket.url) event.preventDefault();
      });
      contents.on('will-redirect', (event) => {
        event.preventDefault();
      });
      const notify = (state: 'visible' | 'hidden' | 'closed') => {
        if (!sender.isDestroyed() && this.input.page(sender) === ticket.page)
          sender.send(APP_EVENT_CHANNEL, {
            type: 'toolWindow',
            ticket: ticket.token,
            state,
          } satisfies AppEvent);
      };
      const visibility = () => {
        notify(child.isVisible() && !child.isMinimized() ? 'visible' : 'hidden');
      };
      child.on('show', visibility);
      child.on('hide', visibility);
      child.on('minimize', visibility);
      child.on('restore', visibility);
      contents.setIgnoreMenuShortcuts(true);
      contents.on('before-input-event', (event, key) => {
        if (
          key.type === 'keyDown' &&
          (process.platform === 'darwin' ? key.meta : key.control) &&
          !key.alt &&
          !key.shift &&
          key.code === 'KeyW'
        ) {
          event.preventDefault();
          child.close();
        }
      });
      contents.once('render-process-gone', () => {
        if (!child.isDestroyed()) child.destroy();
      });
      child.once('closed', () => {
        this.#open.delete(ticket.token);
        unbind?.();
        notify('closed');
      });
    };
    sender.on('did-create-window', attach);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 650,
        height: 540,
        minWidth: 320,
        minHeight: 240,
        autoHideMenuBar: true,
        show: true,
        webPreferences: secureWebPreferences(''),
      },
    };
  }

  #watch(sender: WebContents): void {
    if (this.#watched.has(sender)) return;
    this.#watched.add(sender);
    const clear = () => {
      for (const [key, item] of this.#pending) if (item.owner === sender) this.#pending.delete(key);
      for (const item of this.#open.values())
        if (item.ticket.owner === sender && !item.child.isDestroyed()) item.child.destroy();
    };
    sender.once('destroyed', clear);
    sender.on('render-process-gone', clear);
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) clear();
    });
  }
}
