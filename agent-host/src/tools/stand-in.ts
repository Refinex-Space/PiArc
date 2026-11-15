// Runs Pi's read, write and edit tool code without letting it touch the workspace.
//
// Pi 1.5.2's file tools do all reading and writing through their Operations, but they also probe
// the path they are given with local `fs` calls that Operations do not cover: `read` checks that
// the path (and its macOS spelling variants) exists, `write` and `edit` call `realpath` to key
// their mutation queue. PiArc therefore hands them a stand-in: a unique, never-created path below
// the system temp directory. Pi's probes land there and find nothing; every operation Pi performs
// on the stand-in is carried out by Core on the real path; and every place Pi's results and errors
// repeat the path it was given gets the model's own spelling back.
//
// Probing the stand-in costs a few failed `access`/`realpath` calls on a path outside the
// workspace (docs/spikes/S04-operations-delegation.md).
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Directory the stand-ins live below; nothing is ever created there. */
const STAND_IN_ROOT = path.join(tmpdir(), 'piarc-stand-in');

/** One tool call's stand-in for one real path. */
export class StandIn {
  /** The path given to Pi's tool. */
  readonly path: string;
  /** The absolute path in the workspace that Core operates on. */
  readonly real: string;

  constructor(real: string) {
    this.real = real;
    this.path = path.join(STAND_IN_ROOT, randomUUID(), path.basename(real) || 'file');
  }

  /** The real path for a path Pi passes to an operation: the stand-in or its directory. */
  resolve(requested: string): string {
    if (requested === this.path) {
      return this.real;
    }
    if (requested === path.dirname(this.path)) {
      return path.dirname(this.real);
    }
    throw new Error(`unexpected path ${requested} for the stand-in of ${this.real}`);
  }

  /** `value` (a tool result) with every mention of the stand-in replaced by `spelling`. */
  restore<T>(value: T, spelling: string): T {
    return replaceDeep(value, this.path, spelling);
  }

  /** `error` with every mention of the stand-in in its message replaced by `spelling`. */
  restoreError(error: unknown, spelling: string): unknown {
    if (!(error instanceof Error) || !error.message.includes(this.path)) {
      return error;
    }
    const restored = new Error(error.message.split(this.path).join(spelling));
    restored.name = error.name;
    return restored;
  }
}

function replaceDeep<T>(value: T, from: string, to: string): T {
  return replaceValue(value, from, to) as T;
}

function replaceValue(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    return value.includes(from) ? value.split(from).join(to) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => replaceValue(item, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, replaceValue(member, from, to)]),
    );
  }
  return value;
}

/** Tool calls that change one file run one after another (architecture section 6.1.2). */
const queues = new Map<string, Promise<void>>();

/** Runs `operation` after every earlier operation queued under `key` has finished. */
export async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const done = Promise.withResolvers<undefined>();
  const chained = previous.then(() => done.promise);
  queues.set(key, chained);
  try {
    await previous;
    return await operation();
  } finally {
    done.resolve(undefined);
    if (queues.get(key) === chained) {
      queues.delete(key);
    }
  }
}
