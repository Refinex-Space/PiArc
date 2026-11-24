// One isolated drawing surface per window. Never insert the SVG into the workbench DOM.
import { projectRecord } from '../../../shared/project-files.js';
interface Drawing {
  source: string;
  dark: boolean;
  resolve: (image: string) => void;
  reject: (reason: Error) => void;
  signal: AbortSignal;
}
class DiagramQueue {
  private frame: HTMLIFrameElement | undefined;
  private ready = false;
  private seq = 0;
  private queue: Drawing[] = [];
  private active: Drawing | undefined;
  private timer: number | undefined;
  private cache = new Map<string, string>();
  private cacheSize = 0;
  constructor(private readonly doc: Document) {}
  private key(source: string, dark: boolean) {
    return (dark ? 'd' : 'l') + source;
  }
  draw(source: string, dark: boolean, signal: AbortSignal): Promise<string> {
    if (source.length > 32768) return Promise.reject(new Error('Diagram exceeds 32 KiB'));
    const key = this.key(source, dark),
      cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      this.queue.push({ source, dark, signal, resolve, reject });
      this.next();
    });
  }
  private receive = (event: MessageEvent<unknown>) => {
    if (!event.source || event.source !== this.frame?.contentWindow || !projectRecord(event.data))
      return;
    if (event.data.type === 'diagram-ready') {
      this.ready = true;
      this.clearTimer();
      this.next();
      return;
    }
    if (!this.active || event.data.id !== this.seq) return;
    const task = this.active;
    this.active = undefined;
    this.clearTimer();
    const svg = event.data.svg;
    if (typeof svg === 'string' && svg.length <= 2 * 1024 * 1024 && /^<svg[\s>]/u.test(svg)) {
      const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const key = this.key(task.source, task.dark);
      if (!this.cache.has(key) && image.length <= 2 * 1024 * 1024) {
        while (this.cache.size >= 32 || this.cacheSize + image.length > 4 * 1024 * 1024) {
          const oldest = this.cache.entries().next().value;
          if (!oldest) break;
          this.cacheSize -= oldest[1].length;
          this.cache.delete(oldest[0]);
        }
        this.cache.set(key, image);
        this.cacheSize += image.length;
      }
      task.resolve(image);
    } else
      task.reject(
        new Error(
          typeof event.data.error === 'string' ? event.data.error.slice(0, 250) : 'Invalid diagram',
        ),
      );
    this.next();
  };
  private clearTimer() {
    this.doc.defaultView?.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private reset() {
    this.clearTimer();
    this.doc.defaultView?.removeEventListener('message', this.receive);
    this.frame?.remove();
    this.frame = undefined;
    this.ready = false;
  }
  private next() {
    if (this.active) return;
    const win = this.doc.defaultView;
    if (!win) return;
    while (this.queue[0]?.signal.aborted) this.queue.shift()?.reject(new Error('Cancelled'));
    if (!this.queue.length) {
      this.clearTimer();
      this.timer = win.setTimeout(() => {
        this.reset();
      }, 1000);
      return;
    }
    if (!this.frame) {
      this.clearTimer();
      const frame = this.doc.createElement('iframe');
      frame.className = 'markdown-diagram-engine';
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      // The browser fixture serves the identical assets from its loopback origin.
      frame.src =
        win.location.protocol === 'app:' || win.navigator.userAgent.includes('Electron/')
          ? 'piarc-document://markdown-diagram/index.html'
          : '/markdown-diagram/index.html';
      this.frame = frame;
      win.addEventListener('message', this.receive);
      this.doc.body.append(frame);
      this.timer = win.setTimeout(() => {
        this.reset();
        this.queue.splice(0).forEach((t) => {
          t.reject(new Error('Diagram engine unavailable'));
        });
      }, 12000);
      return;
    }
    if (!this.ready) return;
    this.clearTimer();
    this.active = this.queue.shift();
    if (!this.active) return;
    const { source, dark } = this.active;
    this.seq++;
    this.frame.contentWindow?.postMessage({ id: this.seq, type: 'draw', source, dark }, '*');
    this.timer = win.setTimeout(() => {
      this.active?.reject(new Error('Diagram rendering timed out'));
      this.active = undefined;
      this.reset();
      this.next();
    }, 10000);
  }
}
const windows = new WeakMap<Document, DiagramQueue>();
export function drawDiagram(doc: Document, source: string, dark: boolean, signal: AbortSignal) {
  let queue = windows.get(doc);
  if (!queue) {
    queue = new DiagramQueue(doc);
    windows.set(doc, queue);
  }
  return queue.draw(source, dark, signal);
}
