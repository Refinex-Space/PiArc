// Where a tab's view is on screen (B1.5): attached to the window of the panel that shows it,
// sized to the panel's viewport (fitted and centered when a device is emulated, sharing the
// space with docked DevTools), hidden behind a still frame while something covers it, and
// moved to the hidden parking window when no panel shows it.
import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron';

import type { BrowserBounds, BrowserEmulation } from '../../shared/browser.js';

/** Where a panel wants its page, in the window's DIPs. */
export interface Placement {
  readonly window: BrowserWindow;
  /** The page that sent the placement (the workbench that owns the panel). */
  readonly owner: Electron.WebContents;
  readonly bounds: Rectangle;
  readonly occluded: boolean;
}

/** Share of the viewport docked DevTools take. */
const DEVTOOLS_SHARE = 0.4;

/** Converts the panel's CSS rectangle to the window's DIPs at the page's zoom. */
export function toDips(bounds: BrowserBounds, zoomFactor: number): Rectangle {
  return {
    x: Math.round(bounds.x * zoomFactor),
    y: Math.round(bounds.y * zoomFactor),
    width: Math.max(0, Math.round(bounds.width * zoomFactor)),
    height: Math.max(0, Math.round(bounds.height * zoomFactor)),
  };
}

/** The page's and DevTools' rectangles inside `area` (DevTools docked at the bottom). */
export function splitForDevtools(area: Rectangle): { page: Rectangle; devtools: Rectangle } {
  const devtoolsHeight = Math.round(area.height * DEVTOOLS_SHARE);
  return {
    page: { ...area, height: area.height - devtoolsHeight },
    devtools: {
      x: area.x,
      y: area.y + area.height - devtoolsHeight,
      width: area.width,
      height: devtoolsHeight,
    },
  };
}

/**
 * The rectangle of an emulated device inside `area`: the device's size scaled down to fit
 * and centered, never scaled up. `scale` is what Chromium draws the page at.
 */
export function fitDevice(
  area: Rectangle,
  emulation: Pick<BrowserEmulation, 'width' | 'height'>,
): { rect: Rectangle; scale: number } {
  const scale = Math.min(1, area.width / emulation.width, area.height / emulation.height);
  const width = Math.max(1, Math.round(emulation.width * scale));
  const height = Math.max(1, Math.round(emulation.height * scale));
  return {
    rect: {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    },
    scale,
  };
}

/** Which window holds each view now. */
export class ViewHost {
  readonly #parents = new WeakMap<WebContentsView, BrowserWindow>();
  #parking: BrowserWindow | undefined;

  constructor(private readonly createParking: () => BrowserWindow) {}

  /** Attaches `view` to `window` (on top of the window's other views). */
  attach(view: WebContentsView, window: BrowserWindow): void {
    const parent = this.#parents.get(view);
    if (parent === window && !window.isDestroyed()) return;
    if (parent !== undefined && !parent.isDestroyed()) parent.contentView.removeChildView(view);
    window.contentView.addChildView(view);
    this.#parents.set(view, window);
  }

  /** Keeps `view` running in the hidden parking window at `size`. */
  park(view: WebContentsView, size?: { width: number; height: number }): void {
    const parking = this.parking();
    this.attach(view, parking);
    const width = size?.width ?? 1280;
    const height = size?.height ?? 800;
    view.setBounds({ x: 0, y: 0, width: Math.max(width, 1), height: Math.max(height, 1) });
    view.setVisible(true);
  }

  /** Removes `view` from whatever window holds it. */
  detach(view: WebContentsView): void {
    const parent = this.#parents.get(view);
    if (parent !== undefined && !parent.isDestroyed()) parent.contentView.removeChildView(view);
    this.#parents.delete(view);
  }

  parentOf(view: WebContentsView): BrowserWindow | undefined {
    const parent = this.#parents.get(view);
    return parent === undefined || parent.isDestroyed() ? undefined : parent;
  }

  parking(): BrowserWindow {
    if (this.#parking === undefined || this.#parking.isDestroyed()) {
      this.#parking = this.createParking();
    }
    return this.#parking;
  }

  /** Closes the parking window (app quit). */
  dispose(): void {
    if (this.#parking !== undefined && !this.#parking.isDestroyed()) this.#parking.destroy();
    this.#parking = undefined;
  }
}

/** A view for DevTools docked in the panel (`setDevToolsWebContents` needs a fresh page). */
export function createDevtoolsView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  return view;
}
