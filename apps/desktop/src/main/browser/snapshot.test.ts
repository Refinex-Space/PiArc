// Replays real CDP traffic through takeSnapshot() and checks the ego snapshot requirements
// (ego-lite `docs/native-snapshot-ref-requirement.md`, design addendum `browser.md` B2.4).
//
// How the fixtures in `fixtures/snapshot/` were recorded: a throwaway Electron 45 script (kept out
// of the repository) bundled `snapshot.ts` with esbuild, served the fixture page from a local HTTP
// server on port 47931 (top document on `localhost`, the cross-site iframe on `127.0.0.1`, so it
// runs as an OOPIF), showed it in a 900 × 600 `WebContentsView` with
// `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`, and
// wrapped `webContents.debugger.sendCommand` to record every request and answer of
// `takeSnapshot()` for the full-page, viewport, interactive-only and subtree scopes. It took two
// passes over the unchanged page and stored one after checking that both saw the same answers.
// Answer fields `snapshot.ts` never reads (DOM snapshot text boxes and styles, node values,
// `chromeRole`) were dropped to keep the files reviewable. `main-scrolled.json` is the same page
// after `scrollTo(0, 300)` and stores only the answers that differ from `main.json`.
//
// The page has nested containers, blank and zero-width text, two sibling groups, an image, two
// SVGs, a canvas, a table with an empty cell, repeated "Save" buttons, a hidden copy and a
// visible editor named "Message", "Shared action" in the top document and both frames, a
// same-origin iframe, a cross-site OOPIF (whose backend node ids repeat the top renderer's), an
// open shadow root, generated content and content below the viewport.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { SnapshotRef, SnapshotResult } from '../../shared/browser-host.js';
import type { CdpSend, FrameSession } from './snapshot.js';
import { SNAPSHOT_NODE_LIMIT, SnapshotError, takeSnapshot } from './snapshot.js';

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId: string | undefined;
  readonly result: unknown;
  readonly error: string | undefined;
}

interface Fixture {
  readonly frames: readonly FrameSession[];
  readonly calls: readonly RecordedCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function parseCalls(value: unknown): RecordedCall[] {
  if (!Array.isArray(value)) throw new Error('fixture calls must be an array');
  return value.map((item): RecordedCall => {
    if (!isRecord(item)) throw new Error('fixture call must be an object');
    const method = stringField(item, 'method');
    if (method === undefined) throw new Error('fixture call needs a method');
    return {
      method,
      params: item.params,
      sessionId: stringField(item, 'sessionId'),
      result: item.result,
      error: stringField(item, 'error'),
    };
  });
}

function loadFixture(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/snapshot/${name}`, import.meta.url), 'utf8'),
  );
  if (!isRecord(raw) || !Array.isArray(raw.frames)) throw new Error(`bad fixture ${name}`);
  const frames = raw.frames.map((item): FrameSession => {
    if (!isRecord(item)) throw new Error('fixture frame must be an object');
    const targetId = stringField(item, 'targetId');
    const sessionId = stringField(item, 'sessionId');
    if (targetId === undefined || sessionId === undefined) throw new Error('bad fixture frame');
    return { targetId, sessionId, url: stringField(item, 'url') ?? '' };
  });
  const calls = parseCalls(raw.calls);
  const base = stringField(raw, 'base');
  if (base === undefined) return { frames, calls };
  // A variant stores only the answers that differ from its base fixture.
  const own = new Set(calls.map((call) => callKey(call.sessionId, call.method, call.params)));
  const inherited = loadFixture(base).calls.filter(
    (call) => !own.has(callKey(call.sessionId, call.method, call.params)),
  );
  return { frames, calls: [...calls, ...inherited] };
}

function callKey(sessionId: string | undefined, method: string, params: unknown): string {
  return `${sessionId ?? ''} ${method} ${JSON.stringify(params ?? {})}`;
}

interface SentCall {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId: string | undefined;
}

/**
 * A fake CdpSend answering from the recording. `shuffle` answers later requests first, so a
 * second pass sees the concurrent calls complete in another order.
 */
function replay(fixture: Fixture, shuffle = false): { send: CdpSend; sent: SentCall[] } {
  const answers = new Map(
    fixture.calls.map((call) => [callKey(call.sessionId, call.method, call.params), call]),
  );
  const sent: SentCall[] = [];
  const send: CdpSend = async (method, params = {}, sessionId) => {
    sent.push({ method, params, sessionId });
    const call = answers.get(callKey(sessionId, method, params));
    if (!call) throw new Error(`unrecorded CDP call: ${callKey(sessionId, method, params)}`);
    if (shuffle) {
      const delay = Math.max(0, 12 - sent.length);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (call.error !== undefined) throw new Error(call.error);
    return structuredClone(call.result);
  };
  return { send, sent };
}

/** The accessibility tree a ref's frame would be resolved in, as the SDK resolves it. */
function treeOf(fixture: Fixture, frameId: string | undefined): readonly unknown[] {
  const oopif = fixture.frames.find((frame) => frame.targetId === frameId);
  const call = fixture.calls.find((candidate) => {
    if (candidate.method !== 'Accessibility.getFullAXTree') return false;
    const params = isRecord(candidate.params) ? candidate.params : {};
    if (oopif) return candidate.sessionId === oopif.sessionId && params.frameId === undefined;
    return candidate.sessionId === undefined && params.frameId === frameId;
  });
  const nodes = isRecord(call?.result) ? call.result.nodes : undefined;
  return Array.isArray(nodes) ? nodes : [];
}

function axText(value: unknown): string {
  return isRecord(value) && typeof value.value === 'string' ? value.value : '';
}

/** Resolves a backend node id in one frame's tree, as the SDK resolves a ref. */
function resolveIn(
  fixture: Fixture,
  frameId: string | undefined,
  backendNodeId: number,
): { role: string; name: string } | undefined {
  for (const node of treeOf(fixture, frameId)) {
    if (isRecord(node) && node.backendDOMNodeId === backendNodeId) {
      return { role: axText(node.role), name: axText(node.name) };
    }
  }
  return undefined;
}

function topBackendIds(fixture: Fixture): Set<number> {
  const call = fixture.calls.find(
    (candidate) =>
      candidate.method === 'DOMSnapshot.captureSnapshot' && candidate.sessionId === undefined,
  );
  const ids = new Set<number>();
  const documents = isRecord(call?.result) ? call.result.documents : undefined;
  for (const doc of Array.isArray(documents) ? documents : []) {
    const nodes = isRecord(doc) ? doc.nodes : undefined;
    const backend = isRecord(nodes) ? nodes.backendNodeId : undefined;
    for (const id of Array.isArray(backend) ? backend : []) {
      if (typeof id === 'number') ids.add(id);
    }
  }
  return ids;
}

/** The id of the same-process iframe: its tree is fetched on the page session with `frameId`. */
function sameProcessFrameId(fixture: Fixture): string {
  for (const call of fixture.calls) {
    const frameId = isRecord(call.params) ? call.params.frameId : undefined;
    if (call.method === 'Accessibility.getFullAXTree' && typeof frameId === 'string') {
      return frameId;
    }
  }
  throw new Error('the fixture has no same-process iframe');
}

function refNamed(result: SnapshotResult, name: string, frameId?: string): SnapshotRef {
  const ref = result.refs.find((item) => item.name === name && item.frameId === frameId);
  if (!ref) throw new Error(`no ref named ${name}`);
  return ref;
}

interface TreeNode {
  readonly text: string;
  readonly children: TreeNode[];
}

/** Reads the two-space indentation back into a tree. */
function parseTree(content: string): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { depth: number; node: TreeNode }[] = [];
  for (const line of content.split('\n')) {
    const depth = line.length - line.trimStart().length;
    const node: TreeNode = { text: line.trim(), children: [] };
    while ((stack.at(-1)?.depth ?? -1) >= depth) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  }
  return roots;
}

/** White space (NBSP included) and format characters such as ZWSP only. */
function invisible(text: string): boolean {
  return text.replace(/[\s\p{Cf}]/gu, '') === '';
}

const main = loadFixture('main.json');
const scrolled = loadFixture('main-scrolled.json');
const oopif = main.frames[0];
if (!oopif) throw new Error('the fixture has no OOPIF');

const FULL_PAGE = `root
  heading "Snapshot fixture" level=1
  paragraph
    text "Nested paragraph text"
  container
    text "Alpha one"
    text "Alpha two"
  container
    text "Beta one"
    text "Beta two"
  container
    image "Logo image"
    svg_root "Status icon"
    svg_root
    canvas
  table
    row
      cell "Cell A"
      cell
  container
    button "Save" [ref=1]
    button "Save" [ref=2]
    button "Confirm" [ref=3, loc=role:button[name="Confirm"]]
    button "Shared action" [ref=4]
    link "Docs start" [ref=5, loc=role:link[name="Docs start"], url=http://localhost:47931/docs/start]
    link "Dup link" [ref=6, url=http://localhost:47931/docs/dup]
    link "Dup link" [ref=7, url=http://localhost:47931/docs/dup]
    button "Wrapped" [ref=8, loc=role:button[name="Wrapped"]]
    container [ref=9]
      text "Clickable div"
    text "New"
    button "Shadow action" [ref=10, loc=role:button[name="Shadow action"]]
  container
    textbox "Message" [ref=11, loc=css:#hidden-editor]
    textbox "Message" [ref=12, loc=css:#editor]
      text "Draft"
    textbox "Search" [ref=13, loc=role:textbox[name="Search"]]
    textbox "City" value="Paris" [ref=14, loc=role:textbox[name="City"]]
    container [ref=15]
      checkbox "Remember me" checked [ref=16, loc=role:checkbox[name="Remember me"]]
    combobox "Size" collapsed value="Large" [ref=17, loc=role:combobox[name="Size"]]
      option "Small" [ref=18, loc=role:option[name="Small"]]
      option "Large" selected [ref=19, loc=role:option[name="Large"]]
    group
      disclosuretriangle "More options" collapsed [ref=20, loc=role:disclosuretriangle[name="More options"]]
    list
      listitem
        text "First step"
      listitem
        text "Second step"
  container
    iframe "Same frame" [ref=21, loc=role:iframe[name="Same frame"]]
      root
        paragraph
          text "Same-origin frame content"
        button "Run iframe action" [ref=22]
        button "Shared action" [ref=23]
        textbox "Frame name" [ref=24]
        link "Frame link" [ref=25, loc=href:http://localhost:47931/frame/link, url=http://localhost:47931/frame/link]
    iframe "Cross frame" [ref=26, loc=role:iframe[name="Cross frame"]]
      root
        paragraph
          text "Cross-site frame content"
        button "Run iframe action" [ref=27]
        button "Shared action" [ref=28]
        textbox "Frame name" [ref=29]
        link "Frame link" [ref=30, loc=href:http://127.0.0.1:47931/frame/link, url=http://127.0.0.1:47931/frame/link]
  paragraph
    text "Below the fold text"
  button "Below button" [ref=31, loc=role:button[name="Below button"]]`;

describe('takeSnapshot on recorded Electron 45 traffic', () => {
  it('prints the compact tree of the page with both frames stitched under their iframes', async () => {
    const result = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    expect(result.content).toBe(FULL_PAGE);
    expect(result.truncated).toBe(false);
  });

  it('applies the compaction rules without losing grouping or semantic nodes', async () => {
    const { content } = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    const visitAll = (nodes: readonly TreeNode[]): void => {
      for (const node of nodes) {
        // Blank, NBSP-only and zero-width text is dropped.
        if (node.text.startsWith('text ')) {
          const value: unknown = JSON.parse(node.text.slice('text '.length));
          expect(typeof value === 'string' && invisible(value)).toBe(false);
        }
        // An unnamed container without a ref stays only while it groups two or more children.
        if (node.text === 'container') expect(node.children.length).toBeGreaterThanOrEqual(2);
        visitAll(node.children);
      }
    };
    visitAll(parseTree(content));
    // The two sibling groups stay distinct.
    expect(content).toContain(
      '  container\n    text "Alpha one"\n    text "Alpha two"\n  container\n    text "Beta one"',
    );
    for (const kept of ['image "Logo image"', 'svg_root', 'canvas', 'iframe', 'root', 'listitem']) {
      expect(content).toContain(kept);
    }
    expect(content).toContain('      cell "Cell A"\n      cell\n');
    expect(content).not.toMatch(/loc=(unstable|ambiguous)/);
  });

  it('gives every printed actionable node a distinct ref that resolves in its own frame', async () => {
    const result = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    const printed = [...result.content.matchAll(/\[ref=(\d+)/g)].map((match) => Number(match[1]));
    expect(printed).toEqual(result.refs.map((ref) => ref.refId));
    expect(new Set(printed).size).toBe(printed.length);
    for (const line of result.content.split('\n')) {
      if (/^\s*(button|link|textbox|checkbox|combobox|option|iframe) /.test(line)) {
        expect(line).toMatch(/\[ref=\d+/);
      }
    }
    for (const ref of result.refs) {
      const node = resolveIn(main, ref.frameId, ref.backendNodeId);
      expect(node, `ref ${String(ref.refId)}`).toBeDefined();
      if (ref.name !== '') expect(node?.name).toBe(ref.name);
    }

    // The same-origin frame's refs carry its frame id (the one its own tree was fetched with).
    const sameOriginFrame = sameProcessFrameId(main);
    const sameOrigin = refNamed(result, 'Run iframe action', sameOriginFrame);
    const crossSite = refNamed(result, 'Run iframe action', oopif.targetId);
    expect(sameOrigin.refId).not.toBe(crossSite.refId);
    expect(sameOriginFrame).not.toBe(oopif.targetId);
    expect(refNamed(result, 'Save').frameId).toBeUndefined();
    // The OOPIF's backend ids repeat ids of the top renderer; each ref still resolves in its own
    // frame and nowhere else.
    const repeated = result.refs.filter(
      (ref) => ref.frameId === oopif.targetId && topBackendIds(main).has(ref.backendNodeId),
    );
    expect(repeated.length).toBeGreaterThan(0);
    for (const ref of repeated) {
      expect(resolveIn(main, ref.frameId, ref.backendNodeId)?.name).toBe(ref.name);
      const sameIdInTop = resolveIn(main, undefined, ref.backendNodeId);
      expect(sameIdInTop?.name).not.toBe(ref.name);
    }
  });

  it('prints the same snapshot twice, whatever order concurrent answers arrive in', async () => {
    for (const scope of ['full_page', 'only_within_viewport'] as const) {
      const first = await takeSnapshot(replay(main).send, main.frames, { scope });
      const second = await takeSnapshot(replay(main, true).send, [...main.frames].reverse(), {
        scope,
      });
      expect(second).toEqual(first);
    }
  });

  it('omits a locator unless it is unique in the page and names this node', async () => {
    const result = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    const locOf = (name: string, frameId?: string): string | undefined =>
      refNamed(result, name, frameId).loc;
    // Repeated controls in one document.
    for (const ref of result.refs.filter(
      (item) => item.name === 'Save' || item.name === 'Dup link',
    )) {
      expect(ref.loc).toBeUndefined();
    }
    // A hidden copy and a visible editor sharing a name: no role locator, each keeps its own id.
    const editors = result.refs.filter((ref) => ref.name === 'Message');
    expect(editors.map((ref) => ref.loc)).toEqual(['css:#hidden-editor', 'css:#editor']);
    // The same role and name in the top document and an iframe.
    expect(result.refs.filter((ref) => ref.name === 'Shared action')).toHaveLength(3);
    for (const ref of result.refs.filter((item) => item.name === 'Shared action')) {
      expect(ref.loc).toBeUndefined();
    }
    expect(locOf('Run iframe action', oopif.targetId)).toBeUndefined();
    // A locator from another element (the wrapper's id) never stands for the button inside it.
    expect(locOf('Wrapped')).toBe('role:button[name="Wrapped"]');
    expect(result.refs.some((ref) => ref.loc === 'css:#wrap')).toBe(false);
    // The same path in both frames: only the full URL is unique.
    expect(locOf('Frame link', oopif.targetId)).toBe('href:http://127.0.0.1:47931/frame/link');
    expect(locOf('Confirm')).toBe('role:button[name="Confirm"]');
    for (const ref of result.refs) {
      expect(ref.loc ?? '').not.toMatch(/^(unstable|ambiguous)$/);
    }
  });

  it('limits a viewport snapshot to what is visible and ends it with the overflow line', async () => {
    const view = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'only_within_viewport',
    });
    const lines = view.content.split('\n');
    expect(lines.at(-1)).toBe(
      '[more content below the viewport: scrollY=0, viewport 600 / page 1861 px; scroll or use snapshot({ scope: "full_page" })]',
    );
    expect(view.content).toContain('Cross-site frame content');
    expect(view.content).not.toContain('Below the fold text');
    expect(view.content).not.toContain('css:#hidden-editor'); // positioned at left: -10000px
    expect(view.content).toContain('text "New"'); // generated content follows its box

    const full = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    expect(full.content).not.toContain('[more content');

    const down = await takeSnapshot(replay(scrolled).send, scrolled.frames, {
      scope: 'only_within_viewport',
    });
    expect(down.content.split('\n').at(-1)).toMatch(
      /^\[more content above and below the viewport: scrollY=300, viewport 600 \/ page 1861 px;/,
    );
    expect(down.content).not.toContain('Snapshot fixture');
    expect(down.content).toContain('Cross-site frame content');
  });

  it('cuts content at a line boundary for maxResultLength and keeps the overflow line', async () => {
    const full = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    const firstLines = full.content.split('\n').slice(0, 24).join('\n');
    const cut = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'full_page',
      maxResultLength: firstLines.length + 5,
    });
    expect(cut.content).toBe(firstLines);
    expect(cut.truncated).toBe(true);
    expect(cut.refs.map((ref) => ref.refId)).toEqual([1, 2, 3, 4]);

    const view = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'only_within_viewport',
      maxResultLength: 400,
    });
    expect(view.content.length).toBeLessThanOrEqual(400);
    expect(view.truncated).toBe(true);
    expect(view.content.split('\n').at(-1)).toMatch(/^\[more content below the viewport/);

    const probe = await takeSnapshot(replay(main).send, main.frames, { maxResultLength: 1 });
    expect(probe).toEqual({ content: '', refs: [], truncated: true });
  });

  it('keeps only actionable nodes with interactiveOnly', async () => {
    const result = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'full_page',
      interactiveOnly: true,
    });
    for (const line of result.content.split('\n')) {
      expect(line.trim() === 'root' || /\[ref=\d+/.test(line)).toBe(true);
    }
    expect(result.refs).toHaveLength(31);
  });

  it('starts a subtree at an iframe or at a node inside an OOPIF', async () => {
    const full = await takeSnapshot(replay(main).send, main.frames, { scope: 'full_page' });
    const frame = refNamed(full, 'Cross frame');
    const subtree = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'subtree',
      root: frame.backendNodeId,
    });
    expect(subtree.content.split('\n').slice(0, 3)).toEqual([
      'iframe "Cross frame" [ref=1, loc=role:iframe[name="Cross frame"]]',
      '  root',
      '    paragraph',
    ]);
    expect(subtree.content).not.toContain('Snapshot fixture');
    expect(subtree.refs.slice(1).every((ref) => ref.frameId === oopif.targetId)).toBe(true);

    const button = refNamed(full, 'Run iframe action', oopif.targetId);
    const inner = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'subtree',
      root: button.backendNodeId,
      rootFrame: oopif.targetId,
    });
    expect(inner.content).toBe('button "Run iframe action" [ref=1]');
    expect(inner.refs).toEqual([
      {
        refId: 1,
        backendNodeId: button.backendNodeId,
        frameId: oopif.targetId,
        role: 'button',
        name: 'Run iframe action',
      },
    ]);

    await expect(
      takeSnapshot(replay(main).send, main.frames, { scope: 'subtree', root: 999_999 }),
    ).rejects.toMatchObject({ name: 'SnapshotError', code: 'EGO_SNAPSHOT_FAILED' });
  });

  it('only reads the page and disables Accessibility on every session afterwards', async () => {
    const { send, sent } = replay(main);
    await takeSnapshot(send, main.frames, { scope: 'only_within_viewport' });
    const readOnly = new Set([
      'DOMSnapshot.captureSnapshot',
      'Accessibility.getFullAXTree',
      'Page.getFrameTree',
      'DOM.getFrameOwner',
      'Accessibility.disable',
    ]);
    expect(sent.filter((call) => !readOnly.has(call.method))).toEqual([]);
    const disabled = sent.filter((call) => call.method === 'Accessibility.disable');
    expect(disabled.map((call) => call.sessionId).sort()).toEqual([oopif.sessionId, undefined]);
    expect(sent.slice(-2).every((call) => call.method === 'Accessibility.disable')).toBe(true);
  });

  it('honours includeActionMarks and includeStableLocator', async () => {
    const plain = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'full_page',
      includeActionMarks: false,
    });
    expect(plain.content).not.toContain('[ref=');
    expect(plain.refs).toEqual([]);
    const noLoc = await takeSnapshot(replay(main).send, main.frames, {
      scope: 'full_page',
      includeStableLocator: false,
    });
    expect(noLoc.content).not.toContain('loc=');
    expect(noLoc.refs.every((ref) => ref.loc === undefined)).toBe(true);
  });

  it('shows an OOPIF that cannot be read as an empty iframe', async () => {
    const answers = replay(main);
    const failing: CdpSend = (method, params, sessionId) =>
      sessionId === oopif.sessionId && method !== 'Accessibility.disable'
        ? Promise.reject(new Error('Target closed'))
        : answers.send(method, params, sessionId);
    const result = await takeSnapshot(failing, main.frames, { scope: 'full_page' });
    expect(result.content).toContain('    iframe "Cross frame" [ref=26');
    expect(result.content).not.toContain('Cross-site frame content');
    expect(answers.sent.filter((call) => call.method === 'Accessibility.disable')).toHaveLength(2);
  });
});

/** A one-document page whose root holds the given texts (no DOM beyond the document). */
function syntheticPage(texts: readonly string[]): CdpSend {
  const snapshot = {
    strings: ['TOP', '#document', 'about:blank'],
    documents: [
      {
        frameId: 0,
        documentURL: 2,
        baseURL: 2,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: { parentIndex: [-1], nodeType: [9], nodeName: [1], backendNodeId: [1] },
        layout: { nodeIndex: [0], bounds: [[0, 0, 800, 600]] },
      },
    ],
  };
  const nodes = [
    {
      nodeId: 'root',
      ignored: false,
      role: { type: 'internalRole', value: 'RootWebArea' },
      backendDOMNodeId: 1,
      childIds: texts.map((_, index) => `t${String(index)}`),
    },
    ...texts.map((text, index) => ({
      nodeId: `t${String(index)}`,
      ignored: false,
      role: { type: 'internalRole', value: 'StaticText' },
      name: { type: 'computedString', value: text },
    })),
  ];
  return (method) => {
    if (method === 'DOMSnapshot.captureSnapshot') return Promise.resolve(snapshot);
    if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes });
    if (method === 'Accessibility.disable') return Promise.resolve({});
    return Promise.reject(new Error(`unexpected ${method}`));
  };
}

describe('takeSnapshot limits and input', () => {
  it(`stops after ${String(SNAPSHOT_NODE_LIMIT)} accessibility nodes and says so`, async () => {
    const texts = Array.from(
      { length: SNAPSHOT_NODE_LIMIT + 50 },
      (_, index) => `n${String(index)}`,
    );
    const result = await takeSnapshot(syntheticPage(texts), [], { scope: 'full_page' });
    const lines = result.content.split('\n');
    expect(result.truncated).toBe(true);
    expect(lines.filter((line) => line.startsWith('  text ')).length).toBe(SNAPSHOT_NODE_LIMIT - 1);
    expect(lines.at(-1)).toMatch(/^\[snapshot truncated after 20000 accessibility nodes;/);
  });

  it('keeps every node on one line, whatever its text holds', async () => {
    const separator = String.fromCharCode(0x2028);
    const result = await takeSnapshot(
      syntheticPage([`say "hi"\nnow${separator}later`, String.fromCharCode(0x20, 0xa0, 0x200b)]),
      [],
      { scope: 'full_page' },
    );
    expect(result.content).toBe('root\n  text "say \\"hi\\"\\nnow\\u2028later"');
  });

  it('rejects options the native API does not accept', async () => {
    const send = syntheticPage([]);
    await expect(takeSnapshot(send, [], { scope: 'subtree' })).rejects.toBeInstanceOf(
      SnapshotError,
    );
    await expect(takeSnapshot(send, [], { maxResultLength: -1 })).rejects.toMatchObject({
      code: 'EGO_INVALID_ARGUMENT',
    });
  });

  it('fails with EGO_SNAPSHOT_FAILED when the page cannot be read', async () => {
    const send: CdpSend = (method) =>
      method === 'Accessibility.disable'
        ? Promise.resolve({})
        : Promise.reject(new Error('Debugger is not attached'));
    await expect(takeSnapshot(send, [], {})).rejects.toMatchObject({
      code: 'EGO_SNAPSHOT_FAILED',
    });
  });
});
