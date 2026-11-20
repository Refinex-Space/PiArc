// A session's branch points (T28, architecture section 6.9): where turns of other branches start
// next to a turn of the current branch. The history window reports them (`branches`), then
// `session/branches` when a new message starts at such a place. The user message rows show a
// switcher from here; the conversation shows the point without a turn of the current branch
// (rewound, nothing sent since) above the input.
import type { BranchOption, BranchPoint } from '@piarc/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionOf(value: unknown): BranchOption | undefined {
  if (!isRecord(value) || typeof value.entryId !== 'string' || typeof value.preview !== 'string') {
    return undefined;
  }
  return {
    entryId: value.entryId,
    preview: value.preview,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
  };
}

/** The branch points in `value` (Core's JSON), skipping malformed ones. */
export function branchesOf(value: unknown): BranchPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point: unknown): BranchPoint[] => {
    if (!isRecord(point) || !Array.isArray(point.options)) return [];
    const options = point.options.map(optionOf);
    if (options.some((option) => option === undefined)) return [];
    const index = typeof point.index === 'number' ? point.index : undefined;
    return [
      {
        ...(typeof point.turnId === 'string' ? { turnId: point.turnId } : {}),
        ...(index === undefined ? {} : { index }),
        options: options.filter((option): option is BranchOption => option !== undefined),
      },
    ];
  });
}

export class SessionBranches {
  private points: readonly BranchPoint[] = [];
  private readonly listeners = new Set<() => void>();

  state(): readonly BranchPoint[] {
    return this.points;
  }

  /** The point where turn `turnId` of the current branch has siblings. */
  forTurn(turnId: string | undefined): BranchPoint | undefined {
    return turnId === undefined ? undefined : this.points.find((p) => p.turnId === turnId);
  }

  /** The point at the end of the conversation: other branches, none of the current one yet. */
  tail(): BranchPoint | undefined {
    return this.points.find((p) => p.turnId === undefined);
  }

  /** The points of a freshly loaded history window (`branches`, absent when there are none). */
  load(value: unknown): void {
    this.set(branchesOf(value));
  }

  /** Applies a session notification; false when it is not `session/branches`. */
  apply(method: string, params: Record<string, unknown>): boolean {
    if (method !== 'session/branches') return false;
    this.set(branchesOf(params.branches));
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(points: readonly BranchPoint[]): void {
    this.points = points;
    for (const listener of [...this.listeners]) listener();
  }
}
