// The page snapshot the agent reads to "see" a page in the built-in browser: PiArc's
// implementation of ego-browser's native `ego.snapshot()` contract (ego-lite
// `docs/native-bindings-api.md`, section "Snapshot", and
// `docs/native-snapshot-ref-requirement.md`) over Chrome DevTools Protocol, run in the main
// process (ADR-0089 rule 4, design addendum `browser.md` B2.4).
//
// Sources, per CDP session (the page and every out-of-process iframe the caller attached):
// - `DOMSnapshot.captureSnapshot` once: every document the renderer hosts (the session's frame
//   and its same-process descendants), with layout boxes in layout pixels, attributes, click
//   listeners, shadow-root kinds and which `<iframe>` element hosts which document.
// - `Accessibility.getFullAXTree` once per document (the session's own document without
//   `frameId`, nested same-process documents with it): roles, names, states and structure.
// - `Page.getFrameTree` on an OOPIF session names the parent frame; `DOM.getFrameOwner` on the
//   session hosting that parent gives the `<iframe>` element, so the OOPIF's tree is stitched in
//   under its owner exactly like a same-process document (whose owner comes from the DOM
//   snapshot's `contentDocumentIndex`).
//
// Output: one line per node, two spaces of indentation per level, `root` for each document,
// `container` for structural elements, `text "…"` for text, the lowercase accessibility role for
// everything else (with ego's `iframe`, `svg_root`, `canvas`, `image` names), then the quoted
// name, states, and `[ref=N, loc=…, url=…]` on actionable nodes. Compaction follows the ego
// requirement; a stable locator is printed only when it matches exactly this node in the whole
// page, by the same rules the SDK's validator uses. Nothing here focuses, scrolls, activates or
// reloads a frame, and no script runs in the page.

import type {
  BrowserErrorCode,
  SnapshotOptions,
  SnapshotRef,
  SnapshotResult,
} from '../../shared/browser-host.js';

/** Sends one CDP command; `sessionId` is absent for the tab's own (top document) session. */
export type CdpSend = (method: string, params?: object, sessionId?: string) => Promise<unknown>;

/** An attached out-of-process iframe target (flattened child session of the tab). */
export interface FrameSession {
  readonly targetId: string;
  readonly sessionId: string;
  readonly url: string;
}

/** Accessibility nodes visited per snapshot before the content is cut (B2.4.3). */
export const SNAPSHOT_NODE_LIMIT = 20_000;

/** A snapshot that cannot be taken; `code` is what the binding answers. */
export class SnapshotError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// CDP JSON narrowing

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function numberList(value: unknown): readonly number[] {
  return Array.isArray(value) && value.every((item): item is number => typeof item === 'number')
    ? value
    : [];
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : [];
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function backendId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Geometry (layout pixels of the document the rectangle belongs to)

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rectOf(value: unknown): Rect | undefined {
  const numbers = numberList(value);
  const [x, y, width, height] = numbers;
  if (numbers.length !== 4 || x === undefined || y === undefined) return undefined;
  if (width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

/** A zero-sized box still occupies its point, so a caret or an empty input is not lost. */
function intersects(box: Rect, area: Rect): boolean {
  const width = Math.max(box.width, 1);
  const height = Math.max(box.height, 1);
  return (
    box.x < area.x + area.width &&
    box.x + width > area.x &&
    box.y < area.y + area.height &&
    box.y + height > area.y
  );
}

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

// ---------------------------------------------------------------------------------------------
// DOM snapshot

interface LayoutBox {
  readonly bounds: Rect;
  /** `clientLeft`, `clientTop`, `clientWidth`, `clientHeight` in CSS pixels. */
  readonly client: Rect | undefined;
  /** `offsetLeft`, `offsetTop`, `offsetWidth`, `offsetHeight` in CSS pixels. */
  readonly offset: Rect | undefined;
  /** `scrollLeft`, `scrollTop`, `scrollWidth`, `scrollHeight` in CSS pixels. */
  readonly scroll: Rect | undefined;
}

const UNREACHABLE = 1; // inside a closed or user-agent shadow tree: CSS queries cannot see it
const USER_AGENT = 2; // inside a user-agent shadow tree: browser internals of a control

/** One document of a `DOMSnapshot.captureSnapshot` answer. */
interface DomDocument {
  readonly frameId: string;
  readonly documentUrl: string;
  readonly baseUrl: string;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly contentHeight: number;
  readonly strings: readonly string[];
  readonly parent: readonly number[];
  readonly type: readonly number[];
  readonly name: readonly number[];
  readonly backend: readonly number[];
  readonly attributes: readonly unknown[];
  /** Node index → index of the document it hosts within the same capture. */
  readonly contentDocument: ReadonlyMap<number, number>;
  readonly clickable: ReadonlySet<number>;
  readonly layout: ReadonlyMap<number, LayoutBox>;
  readonly byBackend: ReadonlyMap<number, number>;
  readonly scope: Uint8Array;
}

function rareIntegers(value: unknown): Map<number, number> {
  const data = record(value);
  const index = numberList(data.index);
  const values = numberList(data.value);
  const out = new Map<number, number>();
  index.forEach((node, position) => {
    const item = values[position];
    if (item !== undefined) out.set(node, item);
  });
  return out;
}

function parseDocument(raw: unknown, strings: readonly string[]): DomDocument {
  const doc = record(raw);
  const nodes = record(doc.nodes);
  const layout = record(doc.layout);
  const text = (index: unknown): string =>
    typeof index === 'number' ? (strings[index] ?? '') : '';
  const parent = numberList(nodes.parentIndex);
  const type = numberList(nodes.nodeType);
  const name = numberList(nodes.nodeName);
  const backend = numberList(nodes.backendNodeId);

  const boxes = new Map<number, LayoutBox>();
  const nodeIndex = numberList(layout.nodeIndex);
  const bounds = list(layout.bounds);
  const client = list(layout.clientRects);
  const offset = list(layout.offsetRects);
  const scroll = list(layout.scrollRects);
  nodeIndex.forEach((node, position) => {
    const box = rectOf(bounds[position]);
    if (!box || boxes.has(node)) return;
    boxes.set(node, {
      bounds: box,
      client: rectOf(client[position]),
      offset: rectOf(offset[position]),
      scroll: rectOf(scroll[position]),
    });
  });

  const byBackend = new Map<number, number>();
  backend.forEach((id, index) => byBackend.set(id, index));

  const shadowType = rareIntegers(nodes.shadowRootType);
  const scope = new Uint8Array(parent.length);
  for (let index = 0; index < parent.length; index += 1) {
    const up = parent[index] ?? -1;
    if (up < 0 || up >= index) continue;
    let flags = scope[up] ?? 0;
    const kind = shadowType.get(up);
    if (kind !== undefined) {
      const label = text(kind);
      if (label !== 'open') flags |= UNREACHABLE;
      if (label === 'user-agent') flags |= USER_AGENT;
    }
    scope[index] = flags;
  }

  return {
    frameId: text(doc.frameId),
    documentUrl: text(doc.documentURL),
    baseUrl: text(doc.baseURL),
    scrollX: finite(doc.scrollOffsetX),
    scrollY: finite(doc.scrollOffsetY),
    contentHeight: finite(doc.contentHeight),
    strings,
    parent,
    type,
    name,
    backend,
    attributes: list(nodes.attributes),
    contentDocument: rareIntegers(nodes.contentDocumentIndex),
    clickable: new Set(numberList(record(nodes.isClickable).index)),
    layout: boxes,
    byBackend,
    scope,
  };
}

function nodeName(doc: DomDocument, index: number): string {
  const name = doc.name[index];
  return name === undefined ? '' : (doc.strings[name] ?? '');
}

function attribute(doc: DomDocument, index: number, wanted: string): string | undefined {
  const pairs = numberList(doc.attributes[index]);
  for (let position = 0; position + 1 < pairs.length; position += 2) {
    const key = pairs[position];
    const value = pairs[position + 1];
    if (key === undefined || value === undefined) continue;
    if (doc.strings[key] === wanted) return doc.strings[value] ?? '';
  }
  return undefined;
}

const ELEMENT_NODE = 1;

/** Layout pixels per CSS pixel, from the root element's box (device scale and page zoom). */
function layoutScale(doc: DomDocument): number {
  for (let index = 1; index < doc.parent.length; index += 1) {
    if (doc.parent[index] !== 0 || doc.type[index] !== ELEMENT_NODE) continue;
    const box = doc.layout.get(index);
    const width = box?.offset?.width ?? 0;
    return box && width > 0 && box.bounds.width > 0 ? box.bounds.width / width : 1;
  }
  return 1;
}

function rootElementBox(doc: DomDocument): LayoutBox | undefined {
  for (let index = 1; index < doc.parent.length; index += 1) {
    if (doc.parent[index] === 0 && doc.type[index] === ELEMENT_NODE) return doc.layout.get(index);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Accessibility tree

interface AxTree {
  readonly root: string | undefined;
  readonly nodes: ReadonlyMap<string, Json>;
}

function parseAxTree(raw: unknown): AxTree {
  const nodes = new Map<string, Json>();
  let root: string | undefined;
  for (const item of list(record(raw).nodes)) {
    if (!isRecord(item)) continue;
    const id = item.nodeId;
    if (typeof id !== 'string') continue;
    nodes.set(id, item);
    if (root === undefined && axRole(item) === 'RootWebArea') root = id;
  }
  return { root, nodes };
}

function axValue(value: unknown): unknown {
  return record(value).value;
}

function axRole(node: Json): string {
  const role = axValue(node.role);
  return typeof role === 'string' ? role : '';
}

function axName(node: Json): string {
  const name = axValue(node.name);
  return typeof name === 'string' ? name : '';
}

function axProperty(node: Json, wanted: string): unknown {
  for (const item of list(node.properties)) {
    if (isRecord(item) && item.name === wanted) return axValue(item.value);
  }
  return undefined;
}

/** Ignored for a reason that means the content is not perceivable at all. */
const HIDDEN_REASONS = new Set([
  'notRendered',
  'notVisible',
  'ariaHiddenElement',
  'ariaHiddenSubtree',
  'inertElement',
  'inertSubtree',
  'activeModalDialog',
  'ariaModalDialog',
  'inactiveCarouselTabContent',
]);

function hiddenReason(node: Json): boolean {
  return list(node.ignoredReasons).some(
    (reason) => isRecord(reason) && HIDDEN_REASONS.has(String(reason.name)),
  );
}

/** The role spelling the SDK's resolver compares (`normalizeRole` in `element-resolver.ts`). */
function locatorRole(role: string): string {
  const lower = role.toLowerCase();
  if (lower === 'textfield') return 'textbox';
  if (lower === 'listboxoption') return 'option';
  return lower;
}

/** Roles that are always actionable (lowercase CDP role). */
const ACTION_ROLES = new Set([
  'button',
  'checkbox',
  'colorwell',
  'combobox',
  'date',
  'datetime',
  'disclosuretriangle',
  'inputtime',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'menulistoption',
  'option',
  'popupbutton',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'togglebutton',
  'treeitem',
]);

/** Printed names that differ from the lowercase CDP role. */
const KIND_BY_ROLE = new Map([
  ['RootWebArea', 'root'],
  ['StaticText', 'text'],
  ['generic', 'container'],
  ['none', 'container'],
  ['presentation', 'container'],
  ['Iframe', 'iframe'],
  ['IframePresentational', 'iframe'],
  ['LayoutTable', 'table'],
  ['LayoutTableRow', 'row'],
  ['LayoutTableCell', 'cell'],
]);

/** Roles without content of their own: the text they carry is already in their parent. */
const SKIPPED_ROLES = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);

/** Form controls whose text lives in a user-agent shadow tree: print their value instead. */
const VALUE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const TEXT_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA']);

// ---------------------------------------------------------------------------------------------
// Frames

/** One document with its CDP session and accessibility tree. */
interface Frame {
  readonly dom: DomDocument;
  readonly sessionId: string | undefined;
  /** `''` for the tab's own session; keys renderer-local backend ids. */
  readonly sessionKey: string;
  /** Absent for the top document; the frame id (an OOPIF's target id) otherwise. */
  readonly refFrameId: string | undefined;
  /** The session's own document: fetched without `frameId`, as the SDK's validator does. */
  readonly sessionRoot: boolean;
  readonly scale: number;
  ax: AxTree | undefined;
}

interface SessionCapture {
  readonly sessionId: string | undefined;
  readonly targetId: string | undefined;
  readonly frames: readonly Frame[];
  readonly parentFrameId: string | undefined;
}

async function captureSession(
  send: CdpSend,
  sessionId: string | undefined,
  targetId: string | undefined,
): Promise<SessionCapture> {
  const [snapshot, rootTree, frameTree] = await Promise.all([
    send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true }, sessionId),
    send('Accessibility.getFullAXTree', {}, sessionId),
    targetId === undefined
      ? Promise.resolve(undefined)
      : send('Page.getFrameTree', {}, sessionId).catch(() => undefined),
  ]);
  const data = record(snapshot);
  const strings = stringList(data.strings);
  const documents = list(data.documents).map((raw) => parseDocument(raw, strings));
  const rootIndex = Math.max(
    0,
    targetId === undefined ? 0 : documents.findIndex((doc) => doc.frameId === targetId),
  );
  const sessionKey = sessionId ?? '';
  const frames = documents.map((dom, index): Frame => ({
    dom,
    sessionId,
    sessionKey,
    refFrameId: sessionId === undefined && index === rootIndex ? undefined : dom.frameId,
    sessionRoot: index === rootIndex,
    scale: layoutScale(dom),
    ax: index === rootIndex ? parseAxTree(rootTree) : undefined,
  }));
  await Promise.all(
    frames.map(async (frame) => {
      if (frame.sessionRoot || frame.dom.frameId === '') return;
      try {
        const tree = await send(
          'Accessibility.getFullAXTree',
          { frameId: frame.dom.frameId },
          sessionId,
        );
        frame.ax = parseAxTree(tree);
      } catch {
        // A frame that detached meanwhile is printed as an empty iframe.
      }
    }),
  );
  const parentId = record(record(record(frameTree).frameTree).frame).parentId;
  return {
    sessionId,
    targetId,
    frames,
    parentFrameId: typeof parentId === 'string' ? parentId : undefined,
  };
}

function ownerKey(sessionKey: string, backendNodeId: number): string {
  return `${sessionKey}\u0000${String(backendNodeId)}`;
}

/** Maps `<iframe>` elements (by session and backend id) to the document they host. */
async function frameOwners(
  send: CdpSend,
  captures: readonly SessionCapture[],
): Promise<Map<string, Frame>> {
  const owners = new Map<string, Frame>();
  for (const capture of captures) {
    for (const frame of capture.frames) {
      for (const [node, hosted] of frame.dom.contentDocument) {
        const id = frame.dom.backend[node];
        const child = capture.frames[hosted];
        if (id !== undefined && child) owners.set(ownerKey(frame.sessionKey, id), child);
      }
    }
  }
  const byFrameId = new Map<string, Frame>();
  for (const capture of captures) {
    for (const frame of capture.frames) byFrameId.set(frame.dom.frameId, frame);
  }
  await Promise.all(
    captures.map(async (capture) => {
      const root = capture.frames.find((frame) => frame.sessionRoot);
      if (capture.targetId === undefined || !root) return;
      const parent =
        capture.parentFrameId === undefined ? undefined : byFrameId.get(capture.parentFrameId);
      const ownerSession = parent ? parent.sessionId : undefined;
      try {
        const answer = await send('DOM.getFrameOwner', { frameId: capture.targetId }, ownerSession);
        const id = backendId(record(answer).backendNodeId);
        if (id !== undefined) owners.set(ownerKey(ownerSession ?? '', id), root);
      } catch {
        // The frame went away between enumeration and now: it is simply not shown.
      }
    }),
  );
  return owners;
}

// ---------------------------------------------------------------------------------------------
// Tree

interface SnapNode {
  readonly kind: string;
  readonly name: string;
  readonly states: readonly string[];
  readonly url: string | undefined;
  readonly actionable: boolean;
  readonly frame: Frame;
  readonly backendNodeId: number | undefined;
  /** The accessibility node behind the line, for role locators; absent for ignored elements. */
  readonly axRole: string | undefined;
  children: SnapNode[];
}

interface Build {
  readonly owners: ReadonlyMap<string, Frame>;
  readonly interactiveOnly: boolean;
  budget: number;
  truncated: boolean;
}

/** The text without white space (NBSP included) and invisible format characters (ZWSP…). */
function squash(text: string): string {
  return text.replace(/[\s\p{Cf}]/gu, '');
}

function statesOf(node: Json, role: string, tag: string): string[] {
  const states: string[] = [];
  const checked = axProperty(node, 'checked');
  if (checked === 'true' || checked === true) states.push('checked');
  if (checked === 'mixed') states.push('mixed');
  const pressed = axProperty(node, 'pressed');
  if (pressed === 'true' || pressed === true) states.push('pressed');
  if (pressed === 'mixed') states.push('mixed');
  if (axProperty(node, 'selected') === true) states.push('selected');
  const expanded = axProperty(node, 'expanded');
  if (expanded === true) states.push('expanded');
  if (expanded === false) states.push('collapsed');
  if (axProperty(node, 'disabled') === true) states.push('disabled');
  const level = axProperty(node, 'level');
  if (role === 'heading' && typeof level === 'number') states.push(`level=${String(level)}`);
  const value = axValue(node.value);
  if (VALUE_TAGS.has(tag) && (typeof value === 'string' || typeof value === 'number')) {
    const text = String(value);
    if (text !== '') states.push(`value=${quote(text)}`);
  }
  return states;
}

function linkUrl(node: Json): string | undefined {
  const url = axProperty(node, 'url');
  if (typeof url !== 'string' || url === '') return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'javascript' || scheme === 'data') return undefined;
  return url.length > URL_LIMIT ? `${url.slice(0, URL_LIMIT)}…` : url;
}

const URL_LIMIT = 300;

/** Applies the ego compaction rules to a node whose children are final. */
function compact(node: SnapNode): SnapNode[] {
  if (node.kind === 'text') return squash(node.name) === '' ? [] : [node];
  if (node.kind === 'container' && node.name === '' && !node.actionable) {
    if (node.children.length === 0) return [];
    if (node.children.length === 1) return node.children;
  }
  // `button "Save"` over `text "Save"`: the text is already on the line as the name.
  if (
    node.name !== '' &&
    node.children.length > 0 &&
    node.children.every((child) => child.kind === 'text' && child.children.length === 0) &&
    squash(node.children.map((child) => child.name).join('')) === squash(node.name)
  ) {
    node.children = [];
  }
  return [node];
}

/** Where the walk is: the visible part of the current document and its nearest laid-out box. */
interface Place {
  /** Absent: no viewport filtering. `null`: nothing of this document is visible. */
  readonly visible: Rect | null | undefined;
  /** The nearest ancestor with a layout box intersects `visible`. */
  readonly shownAbove: boolean;
}

function visitChildren(
  build: Build,
  frame: Frame,
  tree: AxTree,
  node: Json,
  place: Place,
): SnapNode[] {
  const out: SnapNode[] = [];
  for (const id of stringList(node.childIds)) {
    out.push(...visit(build, frame, tree, id, place));
    if (build.truncated) break;
  }
  return out;
}

/** The root of a document's tree: always one `root` node, possibly empty. */
function visitDocument(build: Build, frame: Frame, visible: Rect | null | undefined): SnapNode {
  const tree = frame.ax;
  const root: SnapNode = {
    kind: 'root',
    name: '',
    states: [],
    url: undefined,
    actionable: false,
    frame,
    backendNodeId: undefined,
    axRole: undefined,
    children: [],
  };
  if (tree?.root === undefined || visible === null) return root;
  const node = tree.nodes.get(tree.root);
  if (!node) return root;
  build.budget -= 1;
  root.children = visitChildren(build, frame, tree, node, { visible, shownAbove: true });
  return root;
}

/** The part of a hosted document that shows through its `<iframe>` element. */
function frameVisible(
  parent: Frame,
  ownerIndex: number | undefined,
  child: Frame,
  visible: Rect | null | undefined,
): Rect | null | undefined {
  if (visible === undefined) return undefined;
  if (visible === null || ownerIndex === undefined) return null;
  const box = parent.dom.layout.get(ownerIndex);
  if (!box) return null;
  const inner = box.client;
  const content: Rect = inner
    ? {
        x: box.bounds.x + inner.x * parent.scale,
        y: box.bounds.y + inner.y * parent.scale,
        width: inner.width * parent.scale,
        height: inner.height * parent.scale,
      }
    : box.bounds;
  const shown = intersection(content, visible);
  if (!shown) return null;
  const ratio = child.scale / parent.scale;
  return {
    x: (shown.x - content.x) * ratio + child.dom.scrollX,
    y: (shown.y - content.y) * ratio + child.dom.scrollY,
    width: shown.width * ratio,
    height: shown.height * ratio,
  };
}

function visit(build: Build, frame: Frame, tree: AxTree, id: string, place: Place): SnapNode[] {
  const node = tree.nodes.get(id);
  if (!node) return [];
  const role = axRole(node);
  if (role === 'InlineTextBox') return [];
  if (build.budget <= 0) {
    build.truncated = true;
    return [];
  }
  build.budget -= 1;
  if (SKIPPED_ROLES.has(role)) return [];

  const dom = frame.dom;
  const backendNodeId = backendId(node.backendDOMNodeId);
  const index = backendNodeId === undefined ? undefined : dom.byBackend.get(backendNodeId);
  const flags = index === undefined ? 0 : (dom.scope[index] ?? 0);
  // Browser internals of a control (a select's popup, a details' slots): the DOM snapshot leaves
  // user-agent shadow trees out, so a node it does not know is internal. Light-DOM children (the
  // options of a select) are kept.
  if (flags & USER_AGENT || (backendNodeId !== undefined && index === undefined)) {
    return visitChildren(build, frame, tree, node, place);
  }

  const ignored = node.ignored === true;
  if (ignored && hiddenReason(node)) return [];
  const element = index !== undefined && dom.type[index] === ELEMENT_NODE;
  if (ignored && !element) {
    return index === undefined ? visitChildren(build, frame, tree, node, place) : [];
  }
  const tag = index === undefined ? '' : nodeName(dom, index);
  // `<html>` and `<body>` group exactly what the document's `root` line already groups.
  const documentLevel = tag === 'HTML' || tag === 'BODY';
  const box = index === undefined ? undefined : dom.layout.get(index);
  const visible = place.visible;
  const shown =
    visible === undefined ||
    (visible !== null && (box === undefined ? place.shownAbove : intersects(box.bounds, visible)));
  const below: Place = box === undefined ? place : { visible, shownAbove: shown };
  if (ignored && documentLevel) return visitChildren(build, frame, tree, node, below);

  const hosted =
    backendNodeId === undefined
      ? undefined
      : build.owners.get(ownerKey(frame.sessionKey, backendNodeId));
  let kind: string;
  if (hosted) kind = 'iframe';
  else if (tag === 'svg') kind = 'svg_root';
  else if (tag === 'CANVAS') kind = 'canvas';
  else if (ignored) kind = tag === 'IMG' ? 'image' : 'container';
  else kind = KIND_BY_ROLE.get(role) ?? role.toLowerCase();
  if (kind === 'root' || kind === '') kind = 'container';

  const lowerRole = role.toLowerCase();
  const actionable =
    kind !== 'text' &&
    (kind === 'iframe' ||
      (!ignored && ACTION_ROLES.has(lowerRole)) ||
      (!ignored && axProperty(node, 'focusable') === true && !documentLevel) ||
      (index !== undefined && dom.clickable.has(index) && !documentLevel));

  let children: SnapNode[];
  if (hosted) {
    const root = visitDocument(build, hosted, frameVisible(frame, index, hosted, visible));
    const empty = root.children.length === 0;
    children = !hosted.ax || (visible !== undefined && empty) ? [] : [root];
  } else if (TEXT_CONTROL_TAGS.has(tag)) {
    children = []; // The inner editor is user-agent shadow DOM; the value is printed instead.
  } else {
    children = visitChildren(build, frame, tree, node, below);
  }

  // A node outside the viewport stays only as the parent of nodes inside it; text without a box
  // of its own (generated content) follows its nearest laid-out ancestor.
  const ownShown = visible === undefined || (box === undefined ? kind === 'text' && shown : shown);
  if (!ownShown && children.length === 0) return [];

  if (build.interactiveOnly && !actionable) return children;

  const snap: SnapNode = {
    kind,
    name: kind === 'container' && ignored ? '' : axName(node),
    states: ignored ? [] : statesOf(node, lowerRole, tag),
    url: lowerRole === 'link' && !ignored ? linkUrl(node) : undefined,
    actionable,
    frame,
    backendNodeId,
    axRole: ignored ? undefined : role,
    children,
  };
  return compact(snap);
}

/** Finds the accessibility node of `root` in the documents the options allow. */
function subtreeStart(
  captures: readonly SessionCapture[],
  root: number,
  rootFrame: string | undefined,
): { frame: Frame; tree: AxTree; id: string } | undefined {
  const candidates = captures.flatMap((capture) =>
    capture.frames.filter((frame) =>
      rootFrame === undefined
        ? frame.sessionId === undefined
        : frame.dom.frameId === rootFrame || frame.refFrameId === rootFrame,
    ),
  );
  for (const frame of candidates) {
    const tree = frame.ax;
    if (!tree) continue;
    let fallback: string | undefined;
    for (const [id, node] of tree.nodes) {
      if (backendId(node.backendDOMNodeId) !== root) continue;
      if (node.ignored !== true) return { frame, tree, id };
      fallback ??= id;
    }
    if (fallback !== undefined) return { frame, tree, id: fallback };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Stable locators

interface LocatorIndex {
  readonly roles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ids: ReadonlyMap<string, number>;
  readonly paths: ReadonlyMap<string, number>;
  readonly hrefs: ReadonlyMap<string, number>;
}

function roleKey(role: string, name: string): string {
  return `${locatorRole(role)}\u0000${name}`;
}

/** Resolves an anchor's `href` as the SDK's `el.href` does, or undefined when it cannot. */
function resolveHref(frame: Frame, href: string): URL | undefined {
  try {
    return new URL(href, frame.dom.baseUrl || frame.dom.documentUrl);
  } catch {
    return undefined;
  }
}

/**
 * Counts what the SDK's validator (`validateLocatorBackendNodes`) counts, over every document of
 * the page: non-ignored accessibility nodes by role and exact name, and elements reachable by a
 * CSS query (the document and open shadow roots) by `id` and by anchor `href`.
 */
function locatorIndex(captures: readonly SessionCapture[]): LocatorIndex {
  const roles = new Map<string, Set<string>>();
  const ids = new Map<string, number>();
  const paths = new Map<string, number>();
  const hrefs = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const capture of captures) {
    for (const frame of capture.frames) {
      for (const node of frame.ax?.nodes.values() ?? []) {
        const id = backendId(node.backendDOMNodeId);
        if (node.ignored === true || id === undefined) continue;
        const key = roleKey(axRole(node), axName(node));
        const owners = roles.get(key) ?? new Set<string>();
        owners.add(ownerKey(frame.sessionKey, id));
        roles.set(key, owners);
      }
      const dom = frame.dom;
      for (let index = 0; index < dom.type.length; index += 1) {
        if (dom.type[index] !== ELEMENT_NODE || (dom.scope[index] ?? 0) & UNREACHABLE) continue;
        const id = attribute(dom, index, 'id');
        if (id !== undefined && id !== '') bump(ids, id.toLowerCase());
        if (nodeName(dom, index) !== 'A') continue;
        const href = attribute(dom, index, 'href');
        const url = href === undefined ? undefined : resolveHref(frame, href);
        if (!url) continue;
        bump(paths, url.pathname + url.search + url.hash);
        bump(hrefs, url.href);
      }
    }
  }
  return { roles, ids, paths, hrefs };
}

const PLAIN_ID = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/** Fits a CSS string literal as is: no quote, backslash or control character to escape. */
function quotableId(id: string): boolean {
  for (const char of id) {
    const code = char.charCodeAt(0);
    if (char === '"' || char === '\\' || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function stableLocator(index: LocatorIndex, node: SnapNode): string | undefined {
  const frame = node.frame;
  const id = node.backendNodeId;
  if (id === undefined) return undefined;
  if (node.axRole !== undefined && node.name !== '') {
    const owners = index.roles.get(roleKey(node.axRole, node.name));
    if (owners?.size === 1 && owners.has(ownerKey(frame.sessionKey, id))) {
      return `role:${locatorRole(node.axRole)}[name=${quote(node.name)}]`;
    }
  }
  const domIndex = frame.dom.byBackend.get(id);
  if (domIndex === undefined || frame.dom.type[domIndex] !== ELEMENT_NODE) return undefined;
  if ((frame.dom.scope[domIndex] ?? 0) & UNREACHABLE) return undefined;
  const elementId = attribute(frame.dom, domIndex, 'id');
  if (elementId && index.ids.get(elementId.toLowerCase()) === 1) {
    if (PLAIN_ID.test(elementId)) return `css:#${elementId}`;
    if (quotableId(elementId)) return `css:[id="${elementId}"]`;
  }
  if (nodeName(frame.dom, domIndex) !== 'A') return undefined;
  const href = attribute(frame.dom, domIndex, 'href');
  const url = href === undefined ? undefined : resolveHref(frame, href);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  const matches = (value: string): number =>
    (index.paths.get(value) ?? 0) + (index.hrefs.get(value) ?? 0);
  const path = url.pathname + url.search + url.hash;
  if (matches(path) === 1) return `href:${path}`;
  if (matches(url.href) === 1) return `href:${url.href}`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Text

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** A JSON string literal, with the two JS line terminators JSON leaves raw escaped. */
function quote(text: string): string {
  return JSON.stringify(text)
    .replaceAll(LINE_SEPARATOR, '\\' + 'u2028')
    .replaceAll(PARAGRAPH_SEPARATOR, '\\' + 'u2029');
}

interface Line {
  readonly text: string;
  readonly ref: SnapshotRef | undefined;
}

function render(
  nodes: readonly SnapNode[],
  options: { marks: boolean; locators: LocatorIndex | undefined },
): Line[] {
  const lines: Line[] = [];
  let nextRef = 1;
  const walk = (node: SnapNode, depth: number): void => {
    let text = node.kind;
    if (node.kind !== 'root' && node.name !== '') text += ` ${quote(node.name)}`;
    for (const state of node.states) text += ` ${state}`;
    let ref: SnapshotRef | undefined;
    if (options.marks && node.actionable && node.backendNodeId !== undefined) {
      const refId = nextRef;
      nextRef += 1;
      const loc = options.locators ? stableLocator(options.locators, node) : undefined;
      const metadata = [`ref=${String(refId)}`];
      if (loc !== undefined) metadata.push(`loc=${loc}`);
      if (node.url !== undefined) metadata.push(`url=${node.url}`);
      text += ` [${metadata.join(', ')}]`;
      ref = {
        refId,
        backendNodeId: node.backendNodeId,
        ...(node.frame.refFrameId === undefined ? {} : { frameId: node.frame.refFrameId }),
        role: node.kind,
        name: node.name,
        ...(loc === undefined ? {} : { loc }),
      };
    }
    lines.push({ text: `${'  '.repeat(depth)}${text}`, ref });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return lines;
}

/** The SDK's overflow line (`viewportOverflowHint` in ego-browser `page-model.ts`). */
function overflowHint(top: Frame): string {
  const doc = top.dom;
  const viewport = doc.layout.get(0)?.bounds;
  if (!viewport || top.scale <= 0) return '';
  const scrollY = Math.round(doc.scrollY / top.scale);
  const height = Math.round(viewport.height / top.scale);
  const page = Math.round(rootElementBox(doc)?.scroll?.height ?? doc.contentHeight / top.scale);
  const above = scrollY > 1;
  const below = page - (scrollY + height) > 1;
  if (!above && !below) return '';
  const where = above && below ? 'above and below' : above ? 'above' : 'below';
  return `[more content ${where} the viewport: scrollY=${String(scrollY)}, viewport ${String(height)} / page ${String(page)} px; scroll or use snapshot({ scope: "full_page" })]`;
}

const NODE_LIMIT_NOTE = `[snapshot truncated after ${String(SNAPSHOT_NODE_LIMIT)} accessibility nodes; use snapshot({ scope: "subtree", root: "@N" }) for the rest]`;

// ---------------------------------------------------------------------------------------------
// Entry point

type Scope = NonNullable<SnapshotOptions['scope']>;

function isScope(value: unknown): value is Scope {
  return value === 'full_page' || value === 'only_within_viewport' || value === 'subtree';
}

/** The options arrive from the script host over IPC: checked again here, not trusted. */
function checkOptions(options: SnapshotOptions): { scope: Scope; maxLength: number } {
  const scope: unknown = options.scope ?? 'full_page';
  if (!isScope(scope)) {
    throw new SnapshotError('EGO_INVALID_ARGUMENT', `Unknown snapshot scope: ${String(scope)}`);
  }
  if (scope === 'subtree' && backendId(options.root) === undefined) {
    throw new SnapshotError('EGO_INVALID_ARGUMENT', 'A subtree snapshot needs a root backend id');
  }
  const max = options.maxResultLength ?? 0;
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new SnapshotError('EGO_INVALID_ARGUMENT', 'maxResultLength must be a whole number ≥ 0');
  }
  return { scope, maxLength: max };
}

/**
 * Takes one snapshot of the tab. `frames` are the attached out-of-process iframe sessions; the
 * top document uses the tab's own session. Accessibility is disabled on every session afterwards.
 */
export async function takeSnapshot(
  send: CdpSend,
  frames: readonly FrameSession[],
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const { scope, maxLength } = checkOptions(options);
  const oopifs = [...new Map(frames.map((frame) => [frame.sessionId, frame])).values()];
  const used: (string | undefined)[] = [undefined];
  try {
    let top: SessionCapture;
    try {
      top = await captureSession(send, undefined, undefined);
    } catch (error) {
      throw new SnapshotError(
        'EGO_SNAPSHOT_FAILED',
        `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const children = await Promise.all(
      oopifs.map(async (frame) => {
        used.push(frame.sessionId);
        try {
          return await captureSession(send, frame.sessionId, frame.targetId);
        } catch {
          return undefined; // The frame detached: its content is not part of the page any more.
        }
      }),
    );
    const captures = [top, ...children.filter((capture) => capture !== undefined)];
    const topFrame = top.frames.find((frame) => frame.sessionRoot);
    if (topFrame?.ax?.root === undefined) {
      throw new SnapshotError('EGO_SNAPSHOT_FAILED', 'Snapshot failed: the page has no document');
    }
    const build: Build = {
      owners: await frameOwners(send, captures),
      interactiveOnly: options.interactiveOnly === true,
      budget: SNAPSHOT_NODE_LIMIT,
      truncated: false,
    };

    let nodes: SnapNode[];
    if (scope === 'subtree') {
      const start = subtreeStart(captures, options.root ?? 0, options.rootFrame);
      if (!start) {
        throw new SnapshotError(
          'EGO_SNAPSHOT_FAILED',
          `Snapshot root ${String(options.root)} was not found in the page`,
        );
      }
      nodes = visit(build, start.frame, start.tree, start.id, {
        visible: undefined,
        shownAbove: true,
      });
    } else {
      let visible: Rect | undefined;
      const viewport = topFrame.dom.layout.get(0)?.bounds;
      if (scope === 'only_within_viewport' && viewport) {
        visible = {
          x: topFrame.dom.scrollX,
          y: topFrame.dom.scrollY,
          width: viewport.width,
          height: viewport.height,
        };
      }
      nodes = [visitDocument(build, topFrame, visible)];
    }

    const marks = options.includeActionMarks !== false;
    const locators = marks && options.includeStableLocator !== false;
    const lines = render(nodes, {
      marks,
      locators: locators ? locatorIndex(captures) : undefined,
    });
    const tail: string[] = [];
    if (build.truncated) tail.push(NODE_LIMIT_NOTE);
    if (scope === 'only_within_viewport') {
      const hint = overflowHint(topFrame);
      if (hint) tail.push(hint);
    }
    return finish(lines, tail, maxLength, build.truncated);
  } finally {
    await Promise.all(
      used.map((sessionId) => send('Accessibility.disable', {}, sessionId).catch(() => undefined)),
    );
  }
}

/** Joins the lines, cutting at a line boundary to `maxLength` characters (0: no limit). */
function finish(
  lines: readonly Line[],
  tail: readonly string[],
  maxLength: number,
  nodeLimitHit: boolean,
): SnapshotResult {
  const limit = maxLength > 0 ? maxLength : Number.POSITIVE_INFINITY;
  const tailLength = tail.reduce((sum, line) => sum + line.length + 1, 0);
  const kept: string[] = [];
  const refs: SnapshotRef[] = [];
  let length = 0;
  let cut = false;
  for (const line of lines) {
    const next = length + (kept.length > 0 ? 1 : 0) + line.text.length;
    if (next + tailLength > limit) {
      cut = true;
      break;
    }
    kept.push(line.text);
    if (line.ref) refs.push(line.ref);
    length = next;
  }
  for (const line of tail) {
    const next = length + (kept.length > 0 ? 1 : 0) + line.length;
    if (next > limit) {
      cut = true;
      break;
    }
    kept.push(line);
    length = next;
  }
  return { content: kept.join('\n'), refs, truncated: cut || nodeLimitHit };
}
