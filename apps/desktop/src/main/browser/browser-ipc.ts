// The preview panel's IPC (ADR-0088): every argument is checked here before the service sees
// it, and malformed ones throw `TypeError` (T45's hardening sweep calls each with garbage).
import {
  BROWSER_LIMITS,
  EMULATION_LIMITS,
  type BrowserEmulation,
  type BrowserMedia,
  type BrowserPlacement,
  type BrowserRequest,
} from '../../shared/browser.js';
import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { BrowserService } from './service.js';

/** Registers the browser's two channels. */
export function registerBrowserHandlers(register: RegisterHandler, service: BrowserService): void {
  register(IPC_CHANNELS.browserRequest, (event, [id, request]) => {
    if (!isSessionId(id)) throw new TypeError('Invalid session id');
    return service.request(id, parseBrowserRequest(request), event.sender);
  });
  register(IPC_CHANNELS.browserPlace, (event, [id, placement]) => {
    if (!isSessionId(id)) throw new TypeError('Invalid session id');
    return service.place(id, parsePlacement(placement), event.sender);
  });
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object');
  }
  return value as Fields;
}

function text(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`Invalid ${name}`);
  return value;
}

function tabId(value: unknown): string {
  if (typeof value !== 'string' || !/^tab-\d{1,9}$/.test(value)) throw new TypeError('Invalid tab');
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${name}`);
  return value;
}

function optionalFlag(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : flag(value, name);
}

function size(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < EMULATION_LIMITS.min ||
    value > EMULATION_LIMITS.max
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function emulation(value: unknown): Omit<BrowserEmulation, 'by'> | null {
  if (value === null) return null;
  const fields = record(value);
  const scale = fields.deviceScaleFactor;
  if (typeof scale !== 'number' || !(scale >= 1 && scale <= 4)) {
    throw new TypeError('Invalid pixel ratio');
  }
  return {
    width: size(fields.width, 'width'),
    height: size(fields.height, 'height'),
    deviceScaleFactor: scale,
    mobile: flag(fields.mobile, 'mobile'),
    touch: flag(fields.touch, 'touch'),
  };
}

function media(value: unknown): BrowserMedia {
  const fields = record(value);
  const scheme = fields.colorScheme;
  if (scheme !== 'system' && scheme !== 'light' && scheme !== 'dark') {
    throw new TypeError('Invalid color scheme');
  }
  return { colorScheme: scheme, reducedMotion: flag(fields.reducedMotion, 'reducedMotion') };
}

/** A panel request, checked field by field. */
export function parseBrowserRequest(value: unknown): BrowserRequest {
  const fields = record(value);
  const tab = () => tabId(fields.tab);
  switch (fields.op) {
    case 'state':
    case 'reopenClosed':
    case 'clearData':
      return { op: fields.op };
    case 'navigate': {
      const input = text(fields.input, BROWSER_LIMITS.input, 'address');
      return fields.tab === undefined
        ? { op: 'navigate', input }
        : { op: 'navigate', tab: tab(), input };
    }
    case 'newTab': {
      const background = optionalFlag(fields.background, 'background');
      const url =
        fields.url === undefined ? undefined : text(fields.url, BROWSER_LIMITS.input, 'url');
      return {
        op: 'newTab',
        ...(url === undefined ? {} : { url }),
        ...(background === undefined ? {} : { background }),
      };
    }
    case 'closeTab':
    case 'closeOthers':
    case 'selectTab':
    case 'stop':
    case 'stopFind':
    case 'openExternal':
    case 'focus':
    case 'contextMenu':
      return { op: fields.op, tab: tab() };
    case 'moveTab': {
      const index = fields.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 100) {
        throw new TypeError('Invalid index');
      }
      return { op: 'moveTab', tab: tab(), index };
    }
    case 'history':
      if (fields.direction !== 'back' && fields.direction !== 'forward') {
        throw new TypeError('Invalid direction');
      }
      return { op: 'history', tab: tab(), direction: fields.direction };
    case 'reload': {
      const hard = optionalFlag(fields.hard, 'hard');
      return { op: 'reload', tab: tab(), ...(hard === undefined ? {} : { hard }) };
    }
    case 'zoom':
      if (fields.step !== 'in' && fields.step !== 'out' && fields.step !== 'reset') {
        throw new TypeError('Invalid zoom step');
      }
      return { op: 'zoom', tab: tab(), step: fields.step };
    case 'find':
      return {
        op: 'find',
        tab: tab(),
        text: text(fields.text, BROWSER_LIMITS.find, 'find text'),
        forward: flag(fields.forward, 'forward'),
        next: flag(fields.next, 'next'),
      };
    case 'devtools':
      if (fields.mode !== 'closed' && fields.mode !== 'docked' && fields.mode !== 'window') {
        throw new TypeError('Invalid DevTools mode');
      }
      return { op: 'devtools', tab: tab(), mode: fields.mode };
    case 'emulate':
      return { op: 'emulate', tab: tab(), emulation: emulation(fields.emulation) };
    case 'media':
      return { op: 'media', tab: tab(), media: media(fields.media) };
    case 'answer':
      return parseAnswer(fields);
    case 'control': {
      const action = fields.action;
      if (action !== 'takeOver' && action !== 'handBack' && action !== 'stop') {
        throw new TypeError('Invalid control');
      }
      if (typeof fields.space !== 'string' || !/^agent-\d{1,9}$/.test(fields.space)) {
        throw new TypeError('Invalid space');
      }
      return { op: 'control', space: fields.space, action };
    }
    case 'download':
      if (typeof fields.download !== 'string' || !/^[0-9a-f-]{36}$/.test(fields.download)) {
        throw new TypeError('Invalid download');
      }
      if (fields.action !== 'cancel' && fields.action !== 'show') {
        throw new TypeError('Invalid download action');
      }
      return { op: 'download', download: fields.download, action: fields.action };
    default:
      throw new TypeError('Invalid browser request');
  }
}

function parseAnswer(fields: Fields): BrowserRequest {
  if (typeof fields.prompt !== 'string' || !/^[0-9a-f-]{36}$/.test(fields.prompt)) {
    throw new TypeError('Invalid prompt');
  }
  const optional = (name: 'text' | 'user' | 'password') =>
    fields[name] === undefined ? {} : { [name]: text(fields[name], BROWSER_LIMITS.answer, name) };
  return {
    op: 'answer',
    prompt: fields.prompt,
    accept: flag(fields.accept, 'accept'),
    ...optional('text'),
    ...optional('user'),
    ...optional('password'),
  };
}

const MAX_COORDINATE = 100_000;

function coordinate(value: unknown, name: string, min: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > MAX_COORDINATE
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

/** A panel placement, checked field by field. */
export function parsePlacement(value: unknown): BrowserPlacement {
  if (value === null) return null;
  const fields = record(value);
  const bounds = record(fields.bounds);
  const toolWindow = fields.toolWindow;
  if (toolWindow !== undefined && (typeof toolWindow !== 'string' || toolWindow.length > 64)) {
    throw new TypeError('Invalid tool window');
  }
  const claim = optionalFlag(fields.claim, 'claim');
  return {
    bounds: {
      x: coordinate(bounds.x, 'x', -MAX_COORDINATE),
      y: coordinate(bounds.y, 'y', -MAX_COORDINATE),
      width: coordinate(bounds.width, 'width', 0),
      height: coordinate(bounds.height, 'height', 0),
    },
    occluded: flag(fields.occluded, 'occluded'),
    ...(toolWindow === undefined ? {} : { toolWindow }),
    ...(claim === undefined ? {} : { claim }),
  };
}
