// A session's context usage (T27, architecture sections 6.6.5 and 8.2): what Core's
// `contextUsage` returns when the session is shown, then every `session/usage` notification.
// The environment bar's ring and the rail's context card read it.
import type {
  AutoCompactState,
  AutoCompactStop,
  ContextCategories,
  ContextUsage,
} from '@piarc/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The categories in the order the card lists them. */
export const CATEGORY_ORDER: readonly (keyof ContextCategories)[] = [
  'systemPrompt',
  'tools',
  'mcpTools',
  'memory',
  'skills',
  'conversation',
  'toolResults',
  'unclassified',
];

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const STATES: readonly AutoCompactState[] = ['on', 'off', 'stopped'];
const STOPS: readonly AutoCompactStop[] = ['failed', 'ineffective'];

/** A context usage, or undefined when `value` is not one. */
export function usageOf(value: unknown): ContextUsage | undefined {
  if (!isRecord(value) || !isRecord(value.categories)) return undefined;
  const tokens = count(value.tokens);
  const contextWindow = count(value.contextWindow);
  const threshold = count(value.autoCompactThreshold);
  const state = STATES.find((s) => s === value.autoCompact);
  const source =
    value.source === 'provider' || value.source === 'estimate' ? value.source : undefined;
  if (
    tokens === undefined ||
    contextWindow === undefined ||
    threshold === undefined ||
    state === undefined ||
    source === undefined
  ) {
    return undefined;
  }
  const raw = value.categories;
  const [systemPrompt, tools, mcpTools, memory, skills, conversation, toolResults, unclassified] =
    CATEGORY_ORDER.map((category) => count(raw[category]));
  if (
    systemPrompt === undefined ||
    tools === undefined ||
    mcpTools === undefined ||
    memory === undefined ||
    skills === undefined ||
    conversation === undefined ||
    toolResults === undefined ||
    unclassified === undefined
  ) {
    return undefined;
  }
  const categories: ContextCategories = {
    systemPrompt,
    tools,
    mcpTools,
    memory,
    skills,
    conversation,
    toolResults,
    unclassified,
  };
  const stopped = STOPS.find((s) => s === value.autoCompactStopped);
  return {
    tokens,
    contextWindow,
    autoCompactThreshold: threshold,
    ...(value.serverFallback === true ? { serverFallback: true } : {}),
    categories,
    source,
    autoCompact: state,
    ...(stopped === undefined ? {} : { autoCompactStopped: stopped }),
  };
}

/** The share of the window in use, 0–100 (rounded down), or undefined without a window. */
export function percentOf(usage: ContextUsage): number | undefined {
  if (usage.contextWindow <= 0) return undefined;
  return Math.min(100, Math.floor((usage.tokens / usage.contextWindow) * 100));
}

/** The ring's level: a hint at 75 %, a warning at 90 % (architecture section 8.2). */
export type UsageLevel = 'normal' | 'warning' | 'critical';

export function levelOf(percent: number | undefined): UsageLevel {
  if (percent === undefined || percent < 75) return 'normal';
  return percent < 90 ? 'warning' : 'critical';
}

export class SessionContextUsage {
  private usage: ContextUsage | undefined;
  private requested = false;
  private readonly listeners = new Set<() => void>();

  state(): ContextUsage | undefined {
    return this.usage;
  }

  /** Asks Core once per shown session; later updates arrive as notifications. */
  request(fetch: () => Promise<string>): void {
    if (this.requested) return;
    this.requested = true;
    fetch()
      .then((raw) => {
        const usage = usageOf(JSON.parse(raw));
        // A notification that arrived meanwhile is newer.
        if (usage !== undefined && this.usage === undefined) this.set(usage);
      })
      .catch((failure: unknown) => {
        this.requested = false;
        console.warn('[context] the usage is not available yet', failure);
      });
  }

  /** Applies a session notification; false when it is not `session/usage`. */
  apply(method: string, params: Record<string, unknown>): boolean {
    if (method !== 'session/usage') return false;
    const usage = usageOf(params.usage);
    if (usage !== undefined) this.set(usage);
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(next: ContextUsage): void {
    this.usage = next;
    for (const listener of [...this.listeners]) listener();
  }
}
