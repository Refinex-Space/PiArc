// Ported from ego-browser package/ego-browser/src/element-resolver.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: typed (CDP replies as Wire<...>, locators as a union); the CDP sender
// may be a CdpCall or upstream's { sendRaw } adapter; resolveElementCenter, isRawSelector and the
// buildFindElementJs export are dropped with the v1 helpers that used them, together with their
// center-only internals and the already unused findUniqueBackendNodeIdByRoleName.

import type { Protocol } from 'devtools-protocol';

import type { CdpCall, CdpParams, CdpResult, Wire } from './cdp-types.js';
import { isRecord } from './cdp-types.js';
import { parseRef, type RefEntry, type RefMap } from './ref-map.js';
import { ACTION_TARGET_STATE_HELPERS, HIT_TARGET_HELPERS } from './driver/action-target.js';

/**
 * The CDP sender the resolver takes: a `CdpCall` (a driver's `services.cdp`), or upstream's
 * `{ sendRaw }` adapter around one.
 */
export type ResolverCdp = CdpCall | { readonly sendRaw: CdpCall };

/** Frame id → CDP session id of the Page's frames (upstream also accepts a plain object). */
export type IframeSessions = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export type ElementActionability = 'visible' | 'enabled' | 'pointer' | 'pointer-enabled';
interface PageRuntimeContext {
  sessionId: string;
  frameId?: string | undefined;
  ownerFrameId?: string | undefined;
  contextId?: number;
}

/** The main document's context first, then one per frame. */
type PageContextList = [PageRuntimeContext, ...PageRuntimeContext[]];

export interface LocatorBackendCandidate {
  index: number;
  locator: string;
  backendNodeId: number;
  frameId?: string;
}

export interface ResolveElementObjectIdOptions {
  strict?: boolean;
  strictGlobal?: boolean;
  actionability?: ElementActionability | undefined;
}

export interface ResolvedElementObject {
  objectId: string;
  sessionId: string;
  frameId?: string;
}

type TextMode = 'exact' | 'substring';

interface CssLocator {
  kind: 'css';
  selector: string;
  raw: string;
}

interface CssTextLocator {
  kind: 'cssText';
  selector: string;
  mode: TextMode;
  text: string;
  raw: string;
}

interface HrefLocator {
  kind: 'href';
  href: string;
  raw: string;
}

interface TextLocator {
  kind: 'text';
  mode: TextMode;
  text: string;
  raw: string;
}

interface RoleLocator {
  kind: 'role';
  role: string;
  nameMode: TextMode;
  name: string;
  raw: string;
}

/** A locator `>> nth=N` can wrap: anything but a role or another nth. */
type NthBaseLocator = CssLocator | CssTextLocator | HrefLocator | TextLocator;

interface NthLocator {
  kind: 'nth';
  locator: NthBaseLocator;
  index: number;
  raw: string;
}

type Locator = NthBaseLocator | RoleLocator | NthLocator;

/** A locator whose matches are found by querying the DOM. */
type DomLocator = Exclude<Locator, RoleLocator>;

interface RawSelector {
  kind: 'xpath' | 'css';
  selector: string;
  raw: string;
}

type EvaluateResult = CdpResult<'Runtime.evaluate'>;

interface RoleMatch {
  backendNodeId: number;
  frameId: string | undefined;
  ownerFrameId: string | undefined;
  sessionId: string;
}

interface MatchDiagnostics {
  visible: number;
  hidden: number;
  candidates: MatchCandidate[];
}

interface MatchCandidate {
  tag?: string;
  role?: string;
  name?: string;
  visible?: boolean;
  disabled?: boolean;
}

let snapshotLocatorBatchSequence = 0;

export class ElementResolutionError extends Error {
  kind: 'transient' | 'permanent';
  constructor(message: string, kind: 'transient' | 'permanent') {
    super(message);
    this.name = 'ElementResolutionError';
    this.kind = kind;
  }
}

function exceptionText(result: EvaluateResult): string {
  const d = result.exceptionDetails;
  const description = d?.exception?.description;
  if (description) return description;
  return nonEmptyOr(d?.text, 'evaluation error');
}

export async function resolveElementObjectId(
  cdp: ResolverCdp,
  sessionId: string,
  refMap: RefMap,
  selectorOrRef: string,
  iframeSessions: IframeSessions = new Map<string, string>(),
  options: ResolveElementObjectIdOptions = {},
): Promise<ResolvedElementObject> {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(`Unknown ref: ${refId}`, 'transient');
    }
    assertRefProvenance(refMap, entry, refId);
    if (entry.frameProvenance === 'unknown') {
      return resolveRefObjectIdWithRecoveredFrame(cdp, sessionId, iframeSessions, refId, entry);
    }
    const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
    if (entry.backendNodeId !== undefined) {
      try {
        const result = await send(
          cdp,
          'DOM.resolveNode',
          {
            backendNodeId: entry.backendNodeId,
            objectGroup: 'ego-browser',
          },
          effectiveSessionId,
        );
        const objectId = result.object?.objectId;
        if (objectId) {
          return {
            objectId,
            sessionId: effectiveSessionId,
            ...(entry.frameId ? { frameId: entry.frameId } : {}),
          };
        }
      } catch (error) {
        if (!refMap.allowFallback) throw exactRefError(error, refId);
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    if (!refMap.allowFallback) throw staleRefError(refId);
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions,
    );
    const result = await send(
      cdp,
      'DOM.resolveNode',
      { backendNodeId, objectGroup: 'ego-browser' },
      effectiveSessionId,
    );
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new ElementResolutionError(`No objectId for ref ${refId}`, 'permanent');
    }
    return {
      objectId,
      sessionId: effectiveSessionId,
      ...(entry.frameId ? { frameId: entry.frameId } : {}),
    };
  }

  const locator = parseLocatorOrThrow(selectorOrRef);
  if (locator) {
    return resolveLocatorObjectId(cdp, sessionId, locator, iframeSessions, options);
  }

  const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
  if (options.strict) {
    return resolveRawSelectorObjectId(cdp, contexts, parseRawSelector(selectorOrRef), {
      actionability: options.actionability,
    });
  }
  for (const context of contexts) {
    const result = await evaluateInContext(
      cdp,
      context,
      buildFindElementJs(selectorOrRef),
      false,
      'ego-browser',
    );
    if (result.exceptionDetails) {
      throw invalidSelectorError(selectorOrRef, result);
    }
    const objectId = result.result?.objectId;
    if (objectId) {
      return {
        objectId,
        sessionId: context.sessionId,
        ...(context.frameId ? { frameId: context.frameId } : {}),
      };
    }
  }
  throw new ElementResolutionError(`Element not found: ${selectorOrRef}`, 'transient');
}

function staleRefError(refId: string): ElementResolutionError {
  return new ElementResolutionError(`Stale ref: @${refId}; take a new snapshot`, 'permanent');
}

function exactRefError(error: unknown, refId: string): unknown {
  return /(?:no node|could not find node|cannot find node) with given/i.test(String(error))
    ? staleRefError(refId)
    : error;
}

function assertRefProvenance(refMap: RefMap, entry: RefEntry, refId: string): void {
  if (!refMap.allowFallback && entry.frameProvenance === 'unknown') {
    throw new ElementResolutionError(
      `Ref @${refId} has unknown frame provenance; take a new snapshot or use a locator`,
      'permanent',
    );
  }
}

async function resolveRefObjectIdWithRecoveredFrame(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
  refId: string,
  entry: RefEntry,
): Promise<ResolvedElementObject> {
  const allContexts = pageContexts(sessionId, iframeSessions);
  const frameContexts = allContexts.slice(1);
  // Unknown provenance means the snapshot placed this ref under an iframe, so
  // frames are searched first. The main document remains a fallback in case
  // the snapshot text misattributed a page-owned node to a frame.
  const backendNodeId = entry.backendNodeId;
  let matches =
    backendNodeId === undefined
      ? new Map<string, BackendNodeMatch>()
      : await collectBackendNodeMatches(cdp, frameContexts, backendNodeId);
  if (matches.size === 0 && backendNodeId !== undefined) {
    matches = await collectBackendNodeMatches(cdp, allContexts.slice(0, 1), backendNodeId);
  }

  let match: RecoveredMatch;
  const candidates = [...matches.values()];
  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && onlyCandidate) {
    match = onlyCandidate;
  } else if (matches.size > 1) {
    const semanticMatches = candidates.filter(
      (candidate) => candidate.role === normalizeRole(entry.role) && candidate.name === entry.name,
    );
    const [onlySemanticMatch] = semanticMatches;
    if (semanticMatches.length === 1 && onlySemanticMatch) {
      match = onlySemanticMatch;
    } else {
      throw new ElementResolutionError(
        `Ref @${refId} matched ${String(matches.size)} frame contexts because its frame provenance is missing`,
        'permanent',
      );
    }
  } else {
    // strictGlobal resolves before findUniqueRoleMatch consults actionability,
    // so passing it here would only imply a filter that never runs. Ambiguity
    // across the whole page is the answer this recovery path wants anyway.
    match = await findUniqueRoleMatch(cdp, allContexts, entry.role, entry.name, `ref @${refId}`, {
      strictGlobal: true,
    });
  }

  const result = await send(
    cdp,
    'DOM.resolveNode',
    {
      backendNodeId: match.backendNodeId,
      objectGroup: 'ego-browser',
    },
    match.sessionId,
  );
  const objectId = result.object?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(`No objectId for ref @${refId}`, 'permanent');
  }
  const frameId = firstNonEmpty(match.frameId, match.ownerFrameId);
  return {
    objectId,
    sessionId: match.sessionId,
    ...(frameId ? { frameId } : {}),
  };
}

interface RecoveredMatch {
  backendNodeId: number;
  sessionId: string;
  frameId?: string | undefined;
  ownerFrameId?: string | undefined;
}

/** `value` unless it is missing or empty (upstream: `value || fallback`). */
function nonEmptyOr(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/** A count the page reported (upstream: `Number(value || 0)`). */
function countOf(value: unknown): number {
  return value ? Number(value) : 0;
}

/** The first non-empty string (upstream: `a || b`). */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

interface BackendNodeMatch {
  backendNodeId: number;
  sessionId: string;
  frameId?: string;
  role: string;
  name: string;
}

async function collectBackendNodeMatches(
  cdp: ResolverCdp,
  contexts: PageRuntimeContext[],
  backendNodeId: number,
): Promise<Map<string, BackendNodeMatch>> {
  const matches = new Map<string, BackendNodeMatch>();
  if (contexts.length === 0) return matches;
  const trees = await Promise.allSettled(
    contexts.map(async (context) => ({
      context,
      result: await send(
        cdp,
        'Accessibility.getFullAXTree',
        context.frameId ? { frameId: context.frameId } : {},
        context.sessionId,
      ),
    })),
  );
  for (const tree of trees) {
    if (tree.status !== 'fulfilled') continue;
    const { context, result } = tree.value;
    for (const node of result.nodes ?? []) {
      if (node.ignored || node.backendDOMNodeId !== backendNodeId) continue;
      const frameId = firstNonEmpty(context.ownerFrameId, context.frameId);
      const key = `${context.sessionId}\u0000${String(backendNodeId)}`;
      const existing = matches.get(key);
      if (!existing || (!existing.frameId && frameId)) {
        matches.set(key, {
          backendNodeId,
          sessionId: context.sessionId,
          role: normalizeRole(extractAxString(node.role)),
          name: extractAxString(node.name),
          ...(frameId ? { frameId } : {}),
        });
      }
    }
  }
  return matches;
}

/**
 * Validate many native snapshot locators together. DOM locator counts are
 * queried once per execution context, matching nodes are described in
 * parallel, and one object group releases every temporary handle.
 */
export async function validateLocatorBackendNodes(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
  candidates: LocatorBackendCandidate[],
): Promise<Set<number>> {
  const parsed = candidates.flatMap((candidate) => {
    const locator = parseLocator(candidate.locator);
    return locator ? [{ candidate, locator }] : [];
  });
  const roleCandidates = parsed.flatMap(({ candidate, locator }) =>
    locator.kind === 'role' ? [{ candidate, locator }] : [],
  );
  const domCandidates = parsed.flatMap(({ candidate, locator }) =>
    locator.kind !== 'role' ? [{ candidate, locator }] : [],
  );

  const [roleMatches, domMatches] = await Promise.all([
    validateRoleLocatorBackendNodes(cdp, sessionId, iframeSessions, roleCandidates),
    validateDomLocatorBackendNodes(cdp, sessionId, iframeSessions, domCandidates),
  ]);
  return new Set([...roleMatches, ...domMatches]);
}

interface RoleLocatorCandidate {
  candidate: LocatorBackendCandidate;
  locator: RoleLocator;
}

interface DomLocatorCandidate {
  candidate: LocatorBackendCandidate;
  locator: DomLocator;
}

async function validateRoleLocatorBackendNodes(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
  entries: RoleLocatorCandidate[],
): Promise<Set<number>> {
  const valid = new Set<number>();
  if (entries.length === 0) return valid;
  const available = (
    await Promise.all(
      pageContexts(sessionId, iframeSessions).map(async (context) => {
        try {
          const tree = await send(
            cdp,
            'Accessibility.getFullAXTree',
            context.frameId ? { frameId: context.frameId } : {},
            context.sessionId,
          );
          return { context, tree };
        } catch {
          // A detached frame must not discard locators from healthy contexts.
          return undefined;
        }
      }),
    )
  ).filter((item) => item !== undefined);

  for (const entry of entries) {
    const rawMatches = available.flatMap(({ context, tree }) =>
      (tree.nodes ?? []).flatMap((node) => {
        const backendNodeId = node.backendDOMNodeId;
        return !node.ignored &&
          normalizeRole(extractAxString(node.role)) === entry.locator.role &&
          roleNameMatches(extractAxString(node.name), entry.locator.name, entry.locator.nameMode) &&
          typeof backendNodeId === 'number' &&
          Number.isInteger(backendNodeId)
          ? [{ backendNodeId, frameId: context.frameId, sessionId: context.sessionId }]
          : [];
      }),
    );
    const framedNodeKeys = new Set(
      rawMatches
        .filter((match) => match.frameId)
        .map((match) => `${match.sessionId}\u0000${String(match.backendNodeId)}`),
    );
    const matches = rawMatches.filter(
      (match) =>
        Boolean(match.frameId) ||
        !framedNodeKeys.has(`${match.sessionId}\u0000${String(match.backendNodeId)}`),
    );
    const [onlyMatch] = matches;
    if (
      matches.length === 1 &&
      onlyMatch?.backendNodeId === entry.candidate.backendNodeId &&
      locatorContextMatchesCandidate(onlyMatch, entry.candidate, sessionId, iframeSessions)
    ) {
      valid.add(entry.candidate.index);
    }
  }
  return valid;
}

async function validateDomLocatorBackendNodes(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
  entries: DomLocatorCandidate[],
): Promise<Set<number>> {
  const valid = new Set<number>();
  if (entries.length === 0) return valid;

  const candidateContexts = await availableRuntimePageContexts(cdp, sessionId, iframeSessions);
  const countedContexts = (
    await Promise.all(
      candidateContexts.map(async (context) => {
        try {
          const result = await evaluateInContext(
            cdp,
            context,
            buildBatchLocatorCountJs(entries.map((entry) => entry.locator)),
            true,
          );
          const counts = result.result?.value;
          if (
            result.exceptionDetails ||
            !isCountList(counts) ||
            counts.length !== entries.length ||
            counts.some((count) => !Number.isInteger(count) || count < -1)
          ) {
            return undefined;
          }
          return { context, counts };
        } catch {
          // Count failures are scoped to the frame that disappeared.
          return undefined;
        }
      }),
    )
  ).filter((item) => item !== undefined);
  const contexts = countedContexts.map(({ context }) => context);
  const countsByContext = countedContexts.map(({ counts }) => counts);

  const contextForEntry = entries.map((_, entryIndex) => {
    let total = 0;
    let matchedContext = -1;
    for (let contextIndex = 0; contextIndex < contexts.length; contextIndex++) {
      const count = countsByContext[contextIndex]?.[entryIndex] ?? -1;
      if (count < 0) return -1;
      total += count;
      if (count === 1) matchedContext = contextIndex;
    }
    return total === 1 ? matchedContext : -1;
  });
  const objectGroup = `ego-browser-snapshot-locators-${String(++snapshotLocatorBatchSequence)}`;
  const usedSessions = new Set<string>();

  try {
    const resolved = (
      await Promise.all(
        contexts.map(async (context, contextIndex) => {
          const localEntries = entries
            .map((entry, entryIndex) => ({ entry, entryIndex }))
            .filter(({ entryIndex }) => contextForEntry[entryIndex] === contextIndex);
          if (localEntries.length === 0) return [];
          usedSessions.add(context.sessionId);
          try {
            const evaluated = await evaluateInContext(
              cdp,
              context,
              buildBatchLocatorObjectsJs(localEntries.map(({ entry }) => entry.locator)),
              false,
              objectGroup,
            );
            const batchObjectId = evaluated.result?.objectId;
            if (!batchObjectId || evaluated.exceptionDetails) return [];
            const properties = await send(
              cdp,
              'Runtime.getProperties',
              { objectId: batchObjectId, ownProperties: true },
              context.sessionId,
            );
            return localEntries.flatMap(({ entry }, localIndex) => {
              const property = (properties.result ?? []).find(
                (candidate) => candidate.name === String(localIndex),
              );
              const objectId = property?.value?.objectId;
              return objectId ? [{ entry, context, objectId }] : [];
            });
          } catch {
            return [];
          }
        }),
      )
    ).flat();

    await Promise.all(
      resolved.map(async ({ entry, context, objectId }) => {
        try {
          const described = await send(
            cdp,
            'DOM.describeNode',
            { objectId, depth: 0 },
            context.sessionId,
          );
          if (
            described.node?.backendNodeId === entry.candidate.backendNodeId &&
            locatorContextMatchesCandidate(context, entry.candidate, sessionId, iframeSessions)
          ) {
            valid.add(entry.candidate.index);
          }
        } catch {
          // A stale node is unsafe to advertise as a stable locator.
        }
      }),
    );
  } finally {
    await Promise.all(
      [...usedSessions].map((candidateSessionId) =>
        send(cdp, 'Runtime.releaseObjectGroup', { objectGroup }, candidateSessionId).catch(
          ignoreFailure,
        ),
      ),
    );
  }
  return valid;
}

function isCountList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((count) => typeof count === 'number');
}

/** Swallows a best-effort cleanup failure (upstream: `.catch(() => {})`). */
function ignoreFailure(): undefined {
  return undefined;
}

function locatorContextMatchesCandidate(
  context: { sessionId: string; frameId?: string | undefined },
  candidate: LocatorBackendCandidate,
  pageSessionId: string,
  iframeSessions: IframeSessions,
): boolean {
  if (!candidate.frameId) return true;
  const expectedSessionId = resolveFrameSession(candidate.frameId, pageSessionId, iframeSessions);
  const expectedFrameId = expectedSessionId === pageSessionId ? candidate.frameId : undefined;
  return context.sessionId === expectedSessionId && context.frameId === expectedFrameId;
}

async function resolveRawSelectorObjectId(
  cdp: ResolverCdp,
  contexts: PageContextList,
  selector: RawSelector,
  { actionability }: { actionability?: ElementActionability | undefined } = {},
): Promise<ResolvedElementObject> {
  const match = await findUniqueRawSelectorContext(cdp, contexts, selector, {
    actionability,
  });
  const result = await evaluateInContext(
    cdp,
    match,
    match.actionable && actionability
      ? `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}[0] || null)()`
      : buildFindElementJs(selector.raw),
    false,
    'ego-browser',
  );
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(`Element not found: ${selector.raw}`, 'transient');
  }
  const frameId = firstNonEmpty(match.ownerFrameId, match.frameId);
  return {
    objectId,
    sessionId: match.sessionId,
    ...(frameId ? { frameId } : {}),
  };
}

/** A context that holds the selector's match (`actionable`: it can receive input). */
interface ContextMatch extends PageRuntimeContext {
  count?: number;
  actionable?: boolean | number;
}

async function findUniqueRawSelectorContext(
  cdp: ResolverCdp,
  contexts: PageContextList,
  selector: RawSelector,
  { actionability }: { actionability?: ElementActionability | undefined } = {},
): Promise<ContextMatch> {
  const [mainContext, ...frameContexts] = contexts;
  if (actionability) {
    const mainCount = await rawSelectorCount(cdp, mainContext, selector);
    const mainActionable = mainCount
      ? await rawSelectorActionableCount(cdp, mainContext, selector, actionability)
      : 0;
    if (mainActionable === 1) {
      return { ...mainContext, actionable: true };
    }
    if (mainActionable > 1) {
      throw await rawSelectorCountError(cdp, [mainContext], selector, mainCount);
    }
    const matches: ContextMatch[] = [];
    let totalCount = mainCount;
    let actionableCount = 0;
    for (const context of frameContexts) {
      const count = await rawSelectorCount(cdp, context, selector);
      totalCount += count;
      if (count === 0) continue;
      const actionable = await rawSelectorActionableCount(cdp, context, selector, actionability);
      actionableCount += actionable;
      if (actionable > 0) matches.push({ ...context, actionable });
    }
    if (totalCount === 0) {
      throw new ElementResolutionError(`Selector ${selector.raw} matched 0 elements`, 'transient');
    }
    const [firstMatch] = matches;
    if (actionableCount === 1 && firstMatch) {
      return { ...firstMatch, actionable: true };
    }
    if (actionableCount === 0) {
      const blocker = await firstActionabilityBlocker(
        cdp,
        contexts,
        buildRawSelectorElementsJs(selector),
        actionability,
      );
      throw new ElementResolutionError(
        `Selector ${selector.raw} matched ${String(totalCount)} elements, but none can receive input${blocker ? `; ${blocker}` : ''}`,
        'transient',
      );
    }
    throw await rawSelectorCountError(cdp, matches, selector, totalCount);
  }

  const mainCount = await rawSelectorCount(cdp, mainContext, selector);
  if (mainCount > 1) {
    throw await rawSelectorCountError(cdp, [mainContext], selector, mainCount);
  }
  if (mainCount === 1) return mainContext;

  const matches: ContextMatch[] = [];
  let count = 0;
  for (const context of frameContexts) {
    const candidateCount = await rawSelectorCount(cdp, context, selector);
    count += candidateCount;
    if (candidateCount > 0) {
      matches.push({ count: candidateCount, ...context });
    }
  }
  const [onlyMatch] = matches;
  if (count === 0 || !onlyMatch) {
    throw new ElementResolutionError(`Selector ${selector.raw} matched 0 elements`, 'transient');
  }
  if (count > 1) {
    throw await rawSelectorCountError(cdp, matches, selector, count);
  }
  return onlyMatch;
}

async function rawSelectorCount(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
  selector: RawSelector,
): Promise<number> {
  const result = await evaluateInContext(cdp, context, buildRawSelectorCountJs(selector), true);
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  return countOf(result.result?.value);
}

async function rawSelectorActionableCount(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
  selector: RawSelector,
  actionability: ElementActionability,
): Promise<number> {
  const result = await evaluateInContext(
    cdp,
    context,
    `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}.length)()`,
    true,
  );
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  return countOf(result.result?.value);
}

async function rawSelectorCountError(
  cdp: ResolverCdp,
  contexts: PageRuntimeContext[],
  selector: RawSelector,
  count: number,
): Promise<ElementResolutionError> {
  return ambiguityError(
    `Selector ${selector.raw} matched ${String(count)} elements`,
    await collectMatchDiagnostics(cdp, contexts, buildRawSelectorElementsJs(selector)),
  );
}

function invalidSelectorError(raw: string, result: EvaluateResult): ElementResolutionError {
  const hint = numericCssIdHint(raw);
  return new ElementResolutionError(
    `Invalid selector: ${raw}${hint ? `. ${hint}` : ''}: ${exceptionText(result)}`,
    'permanent',
  );
}

function numericCssIdHint(raw: string): string | undefined {
  const value = raw.trim();
  const prefix = value.startsWith('loc=css:') ? 'loc=css:' : value.startsWith('css:') ? 'css:' : '';
  const match = /^#([0-9][A-Za-z0-9_-]*)$/.exec(value.slice(prefix.length));
  if (!match) return undefined;
  const selector = `[id=${JSON.stringify(match[1])}]`;
  return `CSS ids beginning with a digit must be escaped; use ${prefix}${selector}`;
}

function resolveFrameSession(
  frameId: string | undefined,
  sessionId: string,
  iframeSessions: IframeSessions,
): string {
  if (!frameId) {
    return sessionId;
  }
  const frameSessionId = frameSessionOf(iframeSessions, frameId);
  return nonEmptyOr(frameSessionId, sessionId);
}

/** One frame's session id from either form of `iframeSessions`. */
function isSessionMap(value: IframeSessions): value is ReadonlyMap<string, string> {
  return value instanceof Map;
}

function frameSessionOf(iframeSessions: IframeSessions, frameId: string): string | undefined {
  if (isSessionMap(iframeSessions)) {
    return iframeSessions.get(frameId);
  }
  return Object.hasOwn(iframeSessions, frameId) ? iframeSessions[frameId] : undefined;
}

function pageContexts(sessionId: string, iframeSessions: IframeSessions): PageContextList {
  const contexts: PageContextList = [{ sessionId, frameId: undefined, ownerFrameId: undefined }];
  const entries = isSessionMap(iframeSessions)
    ? iframeSessions.entries()
    : Object.entries(iframeSessions);
  for (const [frameId, frameSessionId] of entries) {
    contexts.push({
      sessionId: frameSessionId,
      frameId: frameSessionId === sessionId ? frameId : undefined,
      ownerFrameId: frameId,
    });
  }
  return contexts;
}

async function runtimePageContexts(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
): Promise<PageContextList> {
  const [mainContext, ...frameContexts] = pageContexts(sessionId, iframeSessions);
  return Promise.all([
    runtimePageContext(cdp, mainContext),
    ...frameContexts.map((context) => runtimePageContext(cdp, context)),
  ]);
}

async function availableRuntimePageContexts(
  cdp: ResolverCdp,
  sessionId: string,
  iframeSessions: IframeSessions,
): Promise<PageRuntimeContext[]> {
  const settled = await Promise.allSettled(
    pageContexts(sessionId, iframeSessions).map((context) => runtimePageContext(cdp, context)),
  );
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function runtimePageContext(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
): Promise<PageRuntimeContext> {
  if (!context.frameId) return context;
  try {
    const result = await send(
      cdp,
      'Page.createIsolatedWorld',
      {
        frameId: context.frameId,
        worldName: 'ego-browser-locator',
        grantUniveralAccess: true,
      },
      context.sessionId,
    );
    const contextId = result.executionContextId;
    if (contextId === undefined || !Number.isInteger(contextId)) {
      throw new Error('Page.createIsolatedWorld returned no context id');
    }
    return { ...context, contextId };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    throw new ElementResolutionError(
      `Frame ${context.frameId} is not ready: ${message}`,
      'transient',
    );
  }
}

function evaluateInContext(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
  expression: string,
  returnByValue: boolean,
  objectGroup?: string,
): Promise<EvaluateResult> {
  return send(
    cdp,
    'Runtime.evaluate',
    {
      expression,
      returnByValue,
      awaitPromise: false,
      ...(context.contextId !== undefined ? { contextId: context.contextId } : {}),
      ...(objectGroup ? { objectGroup } : {}),
    },
    context.sessionId,
  );
}

async function resolveLocatorObjectId(
  cdp: ResolverCdp,
  sessionId: string,
  locator: Locator,
  iframeSessions: IframeSessions,
  options: {
    strictGlobal?: boolean | undefined;
    actionability?: ElementActionability | undefined;
  } = {},
): Promise<ResolvedElementObject> {
  if (locator.kind === 'role') {
    const match = await findUniqueRoleMatch(
      cdp,
      pageContexts(sessionId, iframeSessions),
      locator.role,
      locator.name,
      locator.raw,
      {
        nameMode: locator.nameMode,
        strictGlobal: options.strictGlobal,
        actionability: options.actionability,
      },
    );
    const result = await send(
      cdp,
      'DOM.resolveNode',
      {
        backendNodeId: match.backendNodeId,
        objectGroup: 'ego-browser',
      },
      match.sessionId,
    );
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new ElementResolutionError(`No objectId for locator ${locator.raw}`, 'permanent');
    }
    const frameId = firstNonEmpty(match.ownerFrameId, match.frameId);
    return {
      objectId,
      sessionId: match.sessionId,
      ...(frameId ? { frameId } : {}),
    };
  }
  const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
  const match = await findUniqueLocatorContext(cdp, contexts, locator, {
    strictGlobal: options.strictGlobal,
    actionability: options.actionability,
  });
  const result = await evaluateInContext(
    cdp,
    match,
    match.actionable && options.actionability
      ? buildLocatorActionableFindJs(locator, options.actionability)
      : buildLocatorFindJs(locator),
    false,
    'ego-browser',
  );
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(`Element not found: ${locator.raw}`, 'transient');
  }
  const frameId = firstNonEmpty(match.ownerFrameId, match.frameId);
  return {
    objectId,
    sessionId: match.sessionId,
    ...(frameId ? { frameId } : {}),
  };
}

async function findUniqueLocatorContext(
  cdp: ResolverCdp,
  contexts: PageContextList,
  locator: DomLocator,
  {
    strictGlobal = false,
    actionability,
  }: {
    strictGlobal?: boolean | undefined;
    actionability?: ElementActionability | undefined;
  } = {},
): Promise<ContextMatch> {
  const [mainContext, ...frameContexts] = contexts;
  if (actionability) {
    const mainCount = await locatorCount(cdp, mainContext, locator);
    const mainActionable = mainCount
      ? await locatorActionableCount(cdp, mainContext, locator, actionability)
      : 0;
    if (mainActionable === 1) {
      return { count: 1, ...mainContext, actionable: true };
    }
    if (mainActionable > 1) {
      throw await locatorCountError(cdp, [mainContext], locator, mainCount);
    }
    const matches: ContextMatch[] = [];
    let totalCount = mainCount;
    let actionableCount = 0;
    for (const context of frameContexts) {
      const count = await locatorCount(cdp, context, locator);
      totalCount += count;
      if (count === 0) continue;
      const actionable = await locatorActionableCount(cdp, context, locator, actionability);
      actionableCount += actionable;
      if (actionable > 0) {
        matches.push({
          count,
          actionable,
          ...context,
        });
      }
    }
    if (totalCount === 0) {
      throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, 'transient');
    }
    const [firstMatch] = matches;
    if (actionableCount === 1 && firstMatch) {
      return { ...firstMatch, count: 1, actionable: true };
    }
    if (actionableCount === 0) {
      const blocker = await firstActionabilityBlocker(
        cdp,
        contexts,
        buildLocatorElementsJs(locator),
        actionability,
      );
      throw new ElementResolutionError(
        `Locator ${locator.raw} matched ${String(totalCount)} elements, but none can receive input${blocker ? `; ${blocker}` : ''}`,
        'transient',
      );
    }
    throw await locatorCountError(cdp, matches, locator, totalCount);
  }

  const matches: ContextMatch[] = [];
  let count = 0;
  const mainCount = await locatorCount(cdp, mainContext, locator);
  if (mainCount > 1 && !strictGlobal) {
    throw await locatorCountError(cdp, [mainContext], locator, mainCount);
  }
  if (mainCount === 1 && !strictGlobal) {
    return { count: 1, ...mainContext };
  }
  count += mainCount;
  if (mainCount > 0) {
    matches.push({ count: mainCount, ...mainContext });
  }

  for (const context of frameContexts) {
    const candidateCount = await locatorCount(cdp, context, locator);
    count += candidateCount;
    if (candidateCount > 0) {
      matches.push({ count: candidateCount, ...context });
    }
  }
  const [onlyMatch] = matches;
  if (count === 0 || !onlyMatch) {
    throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, 'transient');
  }
  if (count > 1) {
    throw await locatorCountError(cdp, matches, locator, count);
  }
  return onlyMatch;
}

async function findUniqueRoleMatch(
  cdp: ResolverCdp,
  contexts: PageContextList,
  role: string | undefined,
  name: string | undefined,
  raw: string,
  {
    nameMode = 'exact',
    strictGlobal = false,
    actionability,
  }: {
    nameMode?: TextMode;
    strictGlobal?: boolean | undefined;
    actionability?: ElementActionability | undefined;
  } = {},
): Promise<RoleMatch> {
  const matchesIn = async (selectedContexts: PageRuntimeContext[]): Promise<RoleMatch[]> => {
    const matches: RoleMatch[] = [];
    for (const context of selectedContexts) {
      const result = await send(
        cdp,
        'Accessibility.getFullAXTree',
        context.frameId ? { frameId: context.frameId } : {},
        context.sessionId,
      );
      for (const node of result.nodes ?? []) {
        const backendNodeId = node.backendDOMNodeId;
        if (
          !node.ignored &&
          normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
          roleNameMatches(extractAxString(node.name), name, nameMode) &&
          typeof backendNodeId === 'number'
        ) {
          matches.push({
            backendNodeId,
            frameId: context.frameId,
            ownerFrameId: context.ownerFrameId,
            sessionId: context.sessionId,
          });
        }
      }
    }
    return matches;
  };

  const rawMainMatches = await matchesIn(contexts.slice(0, 1));
  let cachedFrameMatches: Promise<RoleMatch[]> | undefined;
  const matchesWithFrameProvenance = async () => {
    cachedFrameMatches ??= matchesIn(contexts.slice(1));
    const frames = await cachedFrameMatches;
    const framedNodeKeys = new Set(
      frames
        .filter((match) => match.frameId)
        .map((match) => `${match.sessionId}\u0000${String(match.backendNodeId)}`),
    );
    const main = rawMainMatches.filter(
      (match) => !framedNodeKeys.has(`${match.sessionId}\u0000${String(match.backendNodeId)}`),
    );
    return { main, frames };
  };
  if (strictGlobal) {
    const { main, frames } = await matchesWithFrameProvenance();
    const matches = [...main, ...frames];
    const [onlyMatch] = matches;
    if (matches.length === 0 || !onlyMatch) {
      throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, 'transient');
    }
    if (matches.length === 1) return onlyMatch;
    throw ambiguityError(`Locator ${raw} matched ${String(matches.length)} elements`);
  }

  if (!actionability) {
    const matches =
      rawMainMatches.length > 0 ? rawMainMatches : (await matchesWithFrameProvenance()).frames;
    const [onlyMatch] = matches;
    if (matches.length === 0 || !onlyMatch) {
      throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, 'transient');
    }
    if (matches.length === 1) return onlyMatch;
    throw ambiguityError(`Locator ${raw} matched ${String(matches.length)} elements`);
  }

  const classify = async (matches: RoleMatch[]) => {
    const actionable: RoleMatch[] = [];
    let blocker: string | undefined;
    for (const match of matches) {
      const result = await roleMatchActionability(cdp, match, actionability);
      if (result.actionable) actionable.push(match);
      else blocker = firstNonEmpty(blocker, result.blocker);
    }
    return { actionable, blocker };
  };
  const provenance = await matchesWithFrameProvenance();
  const mainMatches = provenance.main;
  const main = await classify(mainMatches);
  const [mainActionable] = main.actionable;
  if (main.actionable.length === 1 && mainActionable) return mainActionable;
  if (main.actionable.length > 1) {
    throw ambiguityError(`Locator ${raw} matched ${String(mainMatches.length)} elements`);
  }

  const frames = provenance.frames;
  const frame = await classify(frames);
  const total = mainMatches.length + frames.length;
  if (total === 0) {
    throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, 'transient');
  }
  const [frameActionable] = frame.actionable;
  if (frame.actionable.length === 1 && frameActionable) return frameActionable;
  if (frame.actionable.length === 0) {
    const blocker = firstNonEmpty(main.blocker, frame.blocker);
    throw new ElementResolutionError(
      `Locator ${raw} matched ${String(total)} elements, but none can receive input${blocker ? `; ${blocker}` : ''}`,
      'transient',
    );
  }
  throw ambiguityError(`Locator ${raw} matched ${String(total)} elements`);
}

/** Classify one AX match with the same rules used for DOM selectors. */
async function roleMatchActionability(
  cdp: ResolverCdp,
  match: RoleMatch,
  actionability: ElementActionability,
): Promise<{ actionable: boolean; blocker?: string }> {
  let objectId: string | undefined;
  try {
    const resolved = await send(
      cdp,
      'DOM.resolveNode',
      {
        backendNodeId: match.backendNodeId,
        objectGroup: 'ego-browser',
      },
      match.sessionId,
    );
    objectId = resolved.object?.objectId;
    if (!objectId) return { actionable: false };
    const result = await send(
      cdp,
      'Runtime.callFunctionOn',
      {
        functionDeclaration: `function() {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          if (!this.isConnected) {
            return { actionable: false, blocker: "element is detached from the DOM" };
          }
          if (this.closest?.("[hidden], [inert]")) {
            return { actionable: false, blocker: "element is hidden or inert" };
          }
          const view = this.ownerDocument?.defaultView;
          if (!view) {
            return { actionable: false, blocker: "element has no browsing context" };
          }
          const rect = this.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return { actionable: false, blocker: "element has a zero-sized bounding box" };
          }
          const style = view.getComputedStyle(this);
          if (style.display === "none") {
            return { actionable: false, blocker: "element has display: none" };
          }
          if (style.visibility === "hidden") {
            return { actionable: false, blocker: "element has visibility: hidden" };
          }
          if (
            ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
            isActionTargetDisabled(this)
          ) return { actionable: false, blocker: "element is disabled" };
          if (${JSON.stringify(actionabilityRequiresPointer(actionability))}) {
            const point = actionPointForElement(this);
            if (!point) {
              return { actionable: false, blocker: "element has no actionable point" };
            }
            if (!scrollRequestForPoint(this, point)) {
              const interceptor = interceptingElementAtPoint(this, point);
              if (interceptor) {
                return {
                  actionable: false,
                  blocker: describeHitTarget(interceptor) + " intercepts pointer events"
                };
              }
            }
          }
          return { actionable: true };
        }`,
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      match.sessionId,
    );
    const value = result.result?.value;
    if (typeof value === 'boolean') return { actionable: value };
    const record = isRecord(value) ? value : undefined;
    return {
      actionable: record?.actionable === true,
      ...(typeof record?.blocker === 'string' ? { blocker: record.blocker } : {}),
    };
  } catch {
    return { actionable: false };
  } finally {
    if (objectId) {
      await send(cdp, 'Runtime.releaseObject', { objectId }, match.sessionId).catch(ignoreFailure);
    }
  }
}

async function locatorCount(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
  locator: DomLocator,
): Promise<number> {
  const result = await evaluateInContext(cdp, context, buildLocatorCountJs(locator), true);
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      'permanent',
    );
  }
  return countOf(result.result?.value);
}

async function locatorActionableCount(
  cdp: ResolverCdp,
  context: PageRuntimeContext,
  locator: DomLocator,
  actionability: ElementActionability,
): Promise<number> {
  const result = await evaluateInContext(
    cdp,
    context,
    buildLocatorActionableCountJs(locator, actionability),
    true,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      'permanent',
    );
  }
  return countOf(result.result?.value);
}

async function locatorCountError(
  cdp: ResolverCdp,
  contexts: PageRuntimeContext[],
  locator: DomLocator,
  count: number,
): Promise<ElementResolutionError> {
  return ambiguityError(
    `Locator ${locator.raw} matched ${String(count)} elements`,
    await collectMatchDiagnostics(cdp, contexts, buildLocatorElementsJs(locator)),
  );
}

async function collectMatchDiagnostics(
  cdp: ResolverCdp,
  contexts: PageRuntimeContext[],
  elementsExpression: string,
): Promise<MatchDiagnostics | undefined> {
  const combined: MatchDiagnostics = { visible: 0, hidden: 0, candidates: [] };
  try {
    for (const context of contexts) {
      const result = await evaluateInContext(
        cdp,
        context,
        buildMatchDiagnosticsJs(elementsExpression),
        true,
      );
      const value = result.result?.value;
      if (
        !isRecord(value) ||
        typeof value.visible !== 'number' ||
        typeof value.hidden !== 'number' ||
        !Array.isArray(value.candidates)
      ) {
        continue;
      }
      const candidates: unknown[] = value.candidates;
      combined.visible += value.visible;
      combined.hidden += value.hidden;
      combined.candidates.push(
        ...candidates.slice(0, 3 - combined.candidates.length).map(matchCandidate),
      );
    }
    return combined.visible + combined.hidden > 0 ? combined : undefined;
  } catch {
    // Diagnostics must never replace the original strict-selector failure.
    return undefined;
  }
}

/** One page-reported candidate, keeping only the fields of the expected types. */
function matchCandidate(value: unknown): MatchCandidate {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.tag === 'string' ? { tag: value.tag } : {}),
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.visible === 'boolean' ? { visible: value.visible } : {}),
    ...(typeof value.disabled === 'boolean' ? { disabled: value.disabled } : {}),
  };
}

function ambiguityError(message: string, diagnostics?: MatchDiagnostics): ElementResolutionError {
  const visibility = diagnostics
    ? ` (${String(diagnostics.visible)} visible, ${String(diagnostics.hidden)} hidden)`
    : '';
  const candidates = diagnostics?.candidates.length
    ? ` Candidates: ${diagnostics.candidates
        .map((candidate, index) => `${String(index + 1)}. ${formatCandidate(candidate)}`)
        .join('; ')}.`
    : '';
  return new ElementResolutionError(
    `${message}${visibility}.${candidates} Use a current snapshot ref or a more specific role, text, or CSS selector.`,
    'permanent',
  );
}

function formatCandidate(candidate: MatchCandidate): string {
  const tag = nonEmptyOr(candidate.tag, 'element');
  const role = candidate.role ? ` role=${candidate.role}` : '';
  const name = candidate.name ? ` ${JSON.stringify(candidate.name)}` : '';
  const states = [candidate.visible === false ? 'hidden' : 'visible'];
  if (candidate.disabled) states.push('disabled');
  return `${tag}${role}${name} (${states.join(', ')})`;
}

async function findBackendNodeIdByRoleName(
  cdp: ResolverCdp,
  sessionId: string,
  role: string | undefined,
  name: string | undefined,
  nth?: number,
  frameId?: string,
  iframeSessions: IframeSessions = new Map<string, string>(),
): Promise<number> {
  const [params, effectiveSessionId] = resolveAxSession(frameId, sessionId, iframeSessions);
  const result = await send(cdp, 'Accessibility.getFullAXTree', params, effectiveSessionId);
  const matches = (result.nodes ?? []).filter(
    (node) =>
      !node.ignored &&
      normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
      extractAxString(node.name) === name,
  );
  // This is a recovery path: the ref's backend node is gone, so role and name
  // are the only identity left. They do not distinguish repeated labels, so an
  // ambiguous result must fail loudly instead of silently acting on whichever
  // node happens to come first. A ref that recorded an explicit nth already
  // carries the disambiguator and keeps indexing.
  if (nth === undefined && matches.length > 1) {
    throw new ElementResolutionError(
      `Stale ref for role=${String(role)} name=${String(name)} matched ${String(matches.length)} elements after its node was replaced; take a new snapshot`,
      'permanent',
    );
  }
  const node = matches[nth ?? 0];
  if (!node) {
    throw new ElementResolutionError(
      `Could not locate element with role=${String(role)} name=${String(name)}`,
      'transient',
    );
  }
  const backendNodeId = node.backendDOMNodeId;
  if (typeof backendNodeId !== 'number') {
    throw new ElementResolutionError(
      `AX node has no backendDOMNodeId for role=${String(role)} name=${String(name)}`,
      'permanent',
    );
  }
  return backendNodeId;
}

function resolveAxSession(
  frameId: string | undefined,
  sessionId: string,
  iframeSessions: IframeSessions,
): [{ frameId?: string }, string] {
  if (!frameId) {
    return [{}, sessionId];
  }
  const iframeSession = frameSessionOf(iframeSessions, frameId);
  if (iframeSession && iframeSession !== sessionId) {
    return [{}, iframeSession];
  }
  return [{ frameId }, sessionId];
}

function buildFindElementJs(selector: string): string {
  if (selector.startsWith('xpath=')) {
    return `document.evaluate(${JSON.stringify(selector.slice(6))}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return buildCssFindJs(selector);
}

function parseRawSelector(input: string): RawSelector {
  const raw = input;
  return raw.startsWith('xpath=')
    ? { kind: 'xpath', selector: raw.slice(6), raw }
    : {
        kind: 'css',
        selector: raw.startsWith('css=') ? raw.slice(4) : raw,
        raw,
      };
}

function buildRawSelectorCountJs(selector: RawSelector): string {
  if (selector.kind === 'xpath') {
    return `document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`;
  }
  return buildCssCountJs(selector.selector);
}

function buildRawSelectorElementsJs(selector: RawSelector): string {
  if (selector.kind === 'xpath') {
    return `(() => {
              const result = document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index));
            })()`;
  }
  return buildCssQueryAllJs(selector.selector);
}

function buildLocatorFindJs(locator: DomLocator): string {
  if (locator.kind === 'css') {
    return buildCssFindJs(locator.selector);
  }
  if (locator.kind === 'text') {
    return `(() => ${textElementsJs(locator)}[0] || null)()`;
  }
  if (locator.kind === 'href') {
    return `(() => ${hrefElementsJs(locator.href)}[0] || null)()`;
  }
  return `(() => ${buildLocatorElementsJs(locator)}[0] || null)()`;
}

function buildLocatorActionableFindJs(
  locator: DomLocator,
  actionability: ElementActionability,
): string {
  return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}[0] || null)()`;
}

function buildLocatorActionableCountJs(
  locator: DomLocator,
  actionability: ElementActionability,
): string {
  return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}.length)()`;
}

function buildActionableElementsJs(
  elementsExpression: string,
  actionability: ElementActionability,
): string {
  return `(() => {
            ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
            const __egoActionableMatches = Array.from(${elementsExpression} || []).filter((element) => {
              if (!element?.isConnected || element.closest?.("[hidden], [inert]")) return false;
              const view = element.ownerDocument?.defaultView;
              if (!view) return false;
              const rect = element.getBoundingClientRect();
              const style = view.getComputedStyle(element);
              const visible = rect.width > 0 && rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden";
              if (!visible) return false;
              if (
                ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
                isActionTargetDisabled(element)
              ) return false;
              if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) return true;
              const point = actionPointForElement(element);
              if (!point) return false;
              return Boolean(scrollRequestForPoint(element, point)) ||
                !interceptingElementAtPoint(element, point);
            });
            return __egoActionableMatches;
          })()`;
}

async function firstActionabilityBlocker(
  cdp: ResolverCdp,
  contexts: PageRuntimeContext[],
  elementsExpression: string,
  actionability: ElementActionability,
): Promise<string | undefined> {
  for (const context of contexts) {
    try {
      const result = await evaluateInContext(
        cdp,
        context,
        `(() => {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          for (const element of Array.from(${elementsExpression} || [])) {
            if (!element?.isConnected) return "element is detached from the DOM";
            if (element.closest?.("[hidden], [inert]")) return "element is hidden or inert";
            const view = element.ownerDocument?.defaultView;
            if (!view) return "element has no browsing context";
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return "element has a zero-sized bounding box";
            }
            const style = view.getComputedStyle(element);
            if (style.display === "none") return "element has display: none";
            if (style.visibility === "hidden") return "element has visibility: hidden";
            if (
              ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
              isActionTargetDisabled(element)
            ) return "element is disabled";
            if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) continue;
            const point = actionPointForElement(element);
            if (!point) return "element has no actionable point";
            if (scrollRequestForPoint(element, point)) continue;
            const interceptor = interceptingElementAtPoint(element, point);
            if (interceptor) {
              return describeHitTarget(interceptor) + " intercepts pointer events";
            }
          }
          return null;
        })()`,
        true,
      );
      const value = result.result?.value;
      if (typeof value === 'string') return value;
    } catch {
      // Keep the original actionability error when diagnostics fail.
    }
  }
  return undefined;
}

function buildLocatorCountJs(locator: DomLocator): string {
  if (locator.kind === 'css') {
    return buildCssCountJs(locator.selector);
  }
  if (locator.kind === 'text') {
    return `(() => ${textElementsJs(locator)}.length)()`;
  }
  if (locator.kind === 'href') {
    return `(() => ${hrefElementsJs(locator.href)}.length)()`;
  }
  return `(() => ${buildLocatorElementsJs(locator)}.length)()`;
}

function buildBatchLocatorCountJs(locators: DomLocator[]): string {
  const queries = locators
    .map((locator) => `() => Array.from(${buildLocatorElementsJs(locator)} || []).length`)
    .join(',\n');
  return `(() => {
            const queries = [${queries}];
            return queries.map((query) => {
              try {
                return query();
              } catch {
                return -1;
              }
            });
          })()`;
}

function buildBatchLocatorObjectsJs(locators: DomLocator[]): string {
  return `(() => [${locators.map((locator) => buildLocatorFindJs(locator)).join(',\n')}])()`;
}

function buildLocatorElementsJs(locator: Locator): string {
  if (locator.kind === 'css') {
    return buildCssQueryAllJs(locator.selector);
  }
  if (locator.kind === 'text') {
    return textElementsJs(locator);
  }
  if (locator.kind === 'href') {
    return hrefElementsJs(locator.href);
  }
  if (locator.kind === 'cssText') {
    return cssTextElementsJs(locator);
  }
  if (locator.kind === 'nth') {
    return nthElementsJs(locator);
  }
  throw new Error(`Unsupported locator kind: ${locator.kind}`);
}

function buildMatchDiagnosticsJs(elementsExpression: string): string {
  return `(() => {
            ${ACTION_TARGET_STATE_HELPERS}
            const __egoDescribeMatches = (values) => {
              const elements = Array.from(values || []).filter(Boolean);
              const normalize = (value) =>
                String(value ?? "").replace(/\\s+/g, " ").trim();
              const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return !element.closest("[hidden], [inert]") &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  rect.width > 0 && rect.height > 0;
              };
              const candidates = elements.slice(0, 3).map((element) => {
                const isVisible = visible(element);
                const name = normalize(
                  element.getAttribute?.("aria-label") ||
                  element.getAttribute?.("alt") ||
                  element.getAttribute?.("title") ||
                  element.value ||
                  element.innerText ||
                  element.textContent
                ).slice(0, 80);
                return {
                  tag: String(element.tagName || "element").toLowerCase(),
                  role: element.getAttribute?.("role") || undefined,
                  name: name || undefined,
                  visible: isVisible,
                  disabled: isActionTargetDisabled(element)
                };
              });
              const visibleCount = elements.filter(visible).length;
              return {
                visible: visibleCount,
                hidden: elements.length - visibleCount,
                candidates
              };
            };
            return __egoDescribeMatches(${elementsExpression});
          })()`;
}

function actionabilityRequiresEnabled(actionability: ElementActionability): boolean {
  return actionability === 'enabled' || actionability === 'pointer-enabled';
}

function actionabilityRequiresPointer(actionability: ElementActionability): boolean {
  return actionability === 'pointer' || actionability === 'pointer-enabled';
}

function hrefElementsJs(href: string): string {
  return `${buildCssQueryAllJs('a[href]')}.filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}

function cssTextElementsJs(locator: CssTextLocator): string {
  return `(() => {
            const spec = {
              selector: ${JSON.stringify(locator.selector)},
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "")
                .replace(/[\\u200b\\u00ad]/g, "")
                .replace(/[\\r\\n\\s\\t]+/g, " ")
                .trim();
            const expected = normalize(spec.text);
            const elements = ${buildCssQueryAllJs(locator.selector)};

            function shouldSkip(element) {
              return (
                element.tagName === "SCRIPT" ||
                element.tagName === "NOSCRIPT" ||
                element.tagName === "STYLE" ||
                document.head?.contains(element)
              );
            }

            function elementText(element) {
              if (shouldSkip(element)) {
                return { full: "", normalized: "", immediate: [] };
              }
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                const value = String(element.value || "");
                return { full: value, normalized: normalize(value), immediate: [value] };
              }

              let full = "";
              let currentImmediate = "";
              const immediate = [];
              const flushImmediate = () => {
                if (currentImmediate) immediate.push(currentImmediate);
                currentImmediate = "";
              };
              for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                  full += child.nodeValue || "";
                  currentImmediate += child.nodeValue || "";
                } else if (child.nodeType !== Node.COMMENT_NODE) {
                  flushImmediate();
                  if (child.nodeType === Node.ELEMENT_NODE) {
                    full += elementText(child).full;
                  }
                }
              }
              flushImmediate();
              if (element.shadowRoot) full += elementText(element.shadowRoot).full;
              return { full, normalized: normalize(full), immediate };
            }

            return elements.filter((element) => {
              const text = elementText(element);
              if (spec.mode === "exact") {
                return (
                  (expected === "" && text.immediate.length === 0) ||
                  text.immediate.some((value) => normalize(value) === expected)
                );
              }
              return text.normalized.toLowerCase().includes(expected.toLowerCase());
            });
          })()`;
}

function nthElementsJs(locator: NthLocator): string {
  return `(() => {
            const values = Array.from(${buildLocatorElementsJs(locator.locator)} || []);
            const index = ${String(locator.index)} === -1 ? values.length - 1 : ${String(locator.index)};
            return index >= 0 && index < values.length ? [values[index]] : [];
          })()`;
}

function textElementsJs(locator: TextLocator): string {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            const spec = {
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "").replace(/\\s+/g, " ").trim();
            const expected = normalize(spec.text);
            const excludedTags = new Set([
              "HEAD",
              "NOSCRIPT",
              "SCRIPT",
              "STYLE",
              "TEMPLATE",
              "TITLE"
            ]);
            const elements = __egoQueryAllOpenShadow("*").filter(
              (element) => !excludedTags.has(element.tagName)
            );

            function fullText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(element.textContent);
            }

            function immediateText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(
                [...element.childNodes]
                  .filter((node) => node.nodeType === Node.TEXT_NODE)
                  .map((node) => node.nodeValue)
                  .join(" ")
              );
            }

            function matches(element) {
              if (spec.mode === "exact") return immediateText(element) === expected;
              return fullText(element)
                .toLowerCase()
                .includes(expected.toLowerCase());
            }

            function isComposedDescendant(ancestor, node) {
              let current = node;
              while (current) {
                if (current === ancestor) return true;
                if (current.parentElement) {
                  current = current.parentElement;
                  continue;
                }
                const root = current.getRootNode?.();
                current = root instanceof ShadowRoot ? root.host : null;
              }
              return false;
            }

            const matchesByText = elements.filter(matches);
            return matchesByText.filter(
              (element) =>
                !matchesByText.some(
                  (other) =>
                    other !== element && isComposedDescendant(element, other)
                )
            );
          })()`;
}

// CSS locators from the native snapshot can point into an open shadow tree.
// Query every reachable tree scope so those locators have the same meaning
// when an action reuses them. XPath deliberately keeps document-only semantics.
const OPEN_SHADOW_QUERY_HELPER = `
  function __egoQueryAllOpenShadow(selector) {
    const matches = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      matches.push(...root.querySelectorAll(selector));
      const elements = root.querySelectorAll('*');
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const shadowRoot = elements[index].shadowRoot;
        if (shadowRoot) roots.push(shadowRoot);
      }
    }
    return matches;
  }
`;

function buildCssQueryAllJs(selector: string): string {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)});
          })()`;
}

function buildCssFindJs(selector: string): string {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)})[0] || null;
          })()`;
}

function buildCssCountJs(selector: string): string {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)}).length;
          })()`;
}

function parseLocator(input: unknown): Locator | null {
  const raw = (typeof input === 'string' ? input : '').trim();
  let value = raw;
  if (value.startsWith('loc=')) {
    value = value.slice(4);
  }

  const nth = parseTerminalNth(value);
  if (nth?.valid) {
    const locator = parseLocatorCore(nth.base, raw, true);
    if (!locator || locator.kind === 'role' || locator.kind === 'nth') {
      return null;
    }
    return { kind: 'nth', locator, index: nth.index, raw };
  }
  if (nth) return null;

  return parseLocatorCore(value, raw, false);
}

function parseLocatorCore(value: string, raw: string, allowRawCss: boolean): Locator | null {
  if (value.startsWith('css:')) {
    const selector = value.slice(4);
    return parseCssLocator(selector, raw);
  }
  if (value.startsWith('css=')) {
    const selector = value.slice(4);
    return parseCssLocator(selector, raw);
  }
  if (value.startsWith('href:')) {
    const href = value.slice(5);
    return href ? { kind: 'href', href, raw } : null;
  }
  if (value.startsWith('text=')) {
    const body = value.slice(5).trim();
    if (!body) return null;
    const quoted =
      (body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"));
    const text = quoted ? parseLocatorName(body) : body;
    return normalizeText(text)
      ? {
          kind: 'text',
          mode: quoted ? 'exact' : 'substring',
          text,
          raw,
        }
      : null;
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)\[name(\*=|=)(.+)\]$/.exec(value);
  if (roleMatch) {
    const [, role = '', operator, name = ''] = roleMatch;
    return {
      kind: 'role',
      role: normalizeRole(role),
      nameMode: operator === '*=' ? 'substring' : 'exact',
      name: parseLocatorName(name),
      raw,
    };
  }

  if (allowRawCss || hasTerminalCssTextPseudo(value)) {
    return parseCssLocator(value, raw);
  }
  return null;
}

function parseCssLocator(selector: string, raw: string): CssLocator | CssTextLocator | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  const text = parseTerminalCssText(trimmed);
  if (text?.valid) {
    return {
      kind: 'cssText',
      selector: text.selector,
      mode: text.mode,
      text: text.text,
      raw,
    };
  }
  if (text) return null;
  if (containsUnquotedTextPseudo(trimmed)) return null;
  return { kind: 'css', selector: trimmed, raw };
}

function parseLocatorOrThrow(input: string): Locator | null {
  const locator = parseLocator(input);
  if (locator) return locator;

  const value = input.trim();
  if (
    value.startsWith('loc=') ||
    value.startsWith('role:') ||
    value.startsWith('text=') ||
    value.startsWith('css=') ||
    hasPlaywrightCompatibilitySyntax(value)
  ) {
    throw new ElementResolutionError(
      `Invalid locator: ${value}. Expected loc=role:<role>[name="<exact name>"], loc=role:<role>[name*="<name part>"], loc=css:<selector>, loc=href:<substring>, text=..., css=..., a terminal :has-text(...) or :text-is(...), or a terminal >> nth=N`,
      'permanent',
    );
  }
  return null;
}

type TerminalNth = { valid: false } | { valid: true; base: string; index: number };

function parseTerminalNth(value: string): TerminalNth | undefined {
  const separators = topLevelTokenPositions(value, '>>');
  if (separators.length === 0) return undefined;
  const [position] = separators;
  if (separators.length !== 1 || position === undefined) return { valid: false };
  const base = value.slice(0, position).trim();
  const tail = value.slice(position + 2).trim();
  const match = /^nth=(-?\d+)$/.exec(tail);
  if (!base || !match) return { valid: false };
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < -1) return { valid: false };
  return { valid: true, base, index };
}

type TerminalCssText =
  { valid: false } | { valid: true; selector: string; mode: TextMode; text: string };

function parseTerminalCssText(selector: string): TerminalCssText | undefined {
  const pseudos: { token: string; mode: TextMode }[] = [
    { token: ':has-text(', mode: 'substring' },
    { token: ':text-is(', mode: 'exact' },
  ];
  for (let index = 0; index < selector.length; index += 1) {
    if (!isTopLevelPosition(selector, index)) continue;
    const pseudo = pseudos.find(({ token }) => selector.startsWith(token, index));
    if (!pseudo) continue;
    const open = index + pseudo.token.length - 1;
    const close = matchingParenPosition(selector, open);
    if (close === -1 || selector.slice(close + 1).trim()) {
      return { valid: false };
    }
    const base = selector.slice(0, index).trim();
    const argument = selector.slice(open + 1, close).trim();
    const string = parseCssString(argument);
    if (!base || topLevelTokenPositions(base, ',').length > 0 || !string.valid) {
      return { valid: false };
    }
    return {
      valid: true,
      selector: base,
      mode: pseudo.mode,
      text: string.value,
    };
  }
  return undefined;
}

function hasTerminalCssTextPseudo(value: string): boolean {
  return Boolean(parseTerminalCssText(value));
}

function hasPlaywrightCompatibilitySyntax(value: string): boolean {
  return containsUnquotedTextPseudo(value) || topLevelTokenPositions(value, '>>').length > 0;
}

function containsUnquotedTextPseudo(value: string): boolean {
  const tokens = [':has-text(', ':text-is('];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (tokens.some((token) => value.startsWith(token, index))) return true;
  }
  return false;
}

function topLevelTokenPositions(value: string, token: string): number[] {
  const positions: number[] = [];
  let quote: string | undefined;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') bracketDepth += 1;
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === '(') parenDepth += 1;
    else if (character === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (bracketDepth === 0 && parenDepth === 0 && value.startsWith(token, index)) {
      positions.push(index);
      index += token.length - 1;
    }
  }
  return positions;
}

function isTopLevelPosition(value: string, position: number): boolean {
  let quote: string | undefined;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < position; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      bracketDepth += 1;
    } else if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === '(') {
      parenDepth += 1;
    } else if (character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return !quote && bracketDepth === 0 && parenDepth === 0;
}

function matchingParenPosition(value: string, open: number): number {
  let quote: string | undefined;
  let escaped = false;
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function parseCssString(value: string): { valid: false } | { valid: true; value: string } {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) {
    return { valid: false };
  }

  let decoded = '';
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      return index === value.length - 1 ? { valid: true, value: decoded } : { valid: false };
    }
    if (character === '\n' || character === '\r' || character === '\f') {
      return { valid: false };
    }
    if (character !== '\\') {
      decoded += character ?? '';
      continue;
    }

    index += 1;
    if (index >= value.length) return { valid: false };
    if (value[index] === '\r' && value[index + 1] === '\n') index += 1;
    if (value[index] === '\n' || value[index] === '\r' || value[index] === '\f') {
      continue;
    }

    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(index))?.[0];
    if (!hex) {
      decoded += value[index] ?? '';
      continue;
    }
    index += hex.length - 1;
    const terminator = value[index + 1];
    if (terminator === '\r') {
      index += value[index + 2] === '\n' ? 2 : 1;
    } else if (
      terminator === '\n' ||
      terminator === '\f' ||
      terminator === '\t' ||
      terminator === ' '
    ) {
      index += 1;
    }
    const codePoint = Number.parseInt(hex, 16);
    decoded += codePoint === 0 || codePoint > 0x10ffff ? '�' : String.fromCodePoint(codePoint);
  }
  return { valid: false };
}

function parseLocatorName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function roleNameMatches(
  actual: string,
  expected: string | undefined,
  mode: TextMode = 'exact',
): boolean {
  if (mode === 'exact') return actual === expected;
  return normalizeText(actual).toLowerCase().includes(normalizeText(expected).toLowerCase());
}

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  listboxoption: 'option',
  textfield: 'textbox',
};

function normalizeRole(value: string | undefined): string {
  const role = (value ?? '').toLowerCase();
  return Object.hasOwn(ROLE_ALIASES, role) ? (ROLE_ALIASES[role] ?? role) : role;
}

function extractAxString(value: Wire<Protocol.Accessibility.AXValue> | undefined): string {
  const raw = value?.value;
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  return '';
}

function send<M extends string>(
  cdp: ResolverCdp,
  method: M,
  params: CdpParams<M>,
  sessionId?: string,
): Promise<CdpResult<M>> {
  return typeof cdp === 'function'
    ? cdp(method, params, sessionId)
    : cdp.sendRaw(method, params, sessionId);
}
