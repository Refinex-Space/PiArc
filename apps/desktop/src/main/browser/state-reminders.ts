// What the user changed in a session's browser between the agent's calls (design addendum
// B2.7.3): after each `Browser` run the state the agent saw is remembered; when the session's
// task spaces later differ (the user took one over or handed it back, pages moved on, tabs
// closed), the newest state goes to Core as `browserState`, which keeps it as one reminder for
// the model's next request. Nothing is said while a script runs (the agent drives the changes
// then) or before the agent used the browser in the session.

/** Quiet time before a change is reported (pages often navigate in bursts). */
export const STATE_REMINDER_DELAY_MS = 500;

/** The JSON Core takes (`BrowserStateSummary` of the protocol, without the session). */
export interface StateSummary {
  readonly spaces: readonly {
    readonly id: number;
    readonly name: string;
    readonly controlledBy: 'agent' | 'user';
    readonly tabs: readonly { readonly title: string; readonly url: string }[];
    readonly tabCount: number;
  }[];
  readonly userTabs: number;
}

export interface StateReminderDeps {
  /** The session's task spaces and the user's tab count now. */
  summary(sessionId: string): StateSummary;
  /** An agent's script runs in one of the session's Spaces. */
  running(sessionId: string): boolean;
  send(sessionId: string, summary: StateSummary): void;
}

export class StateReminders {
  /** What the agent last saw (after its run) or was last told, per session. */
  readonly #seen = new Map<string, string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: StateReminderDeps) {}

  /** A `Browser` run of the session ended: its state is what the agent knows. */
  runEnded(sessionId: string): void {
    this.#cancel(sessionId);
    this.#seen.set(sessionId, JSON.stringify(this.deps.summary(sessionId)));
  }

  /** Something in the session's browser changed. */
  changed(sessionId: string): void {
    if (!this.#seen.has(sessionId) || this.#timers.has(sessionId)) return;
    this.#timers.set(
      sessionId,
      setTimeout(() => {
        this.#timers.delete(sessionId);
        this.#report(sessionId);
      }, STATE_REMINDER_DELAY_MS),
    );
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    this.#cancel(sessionId);
    this.#seen.delete(sessionId);
  }

  #report(sessionId: string): void {
    if (this.deps.running(sessionId)) return;
    const summary = this.deps.summary(sessionId);
    const key = JSON.stringify(summary);
    if (this.#seen.get(sessionId) === key) return;
    try {
      this.deps.send(sessionId, summary);
      this.#seen.set(sessionId, key);
    } catch (error) {
      console.warn('[browser] Core did not take the browser state', error);
    }
  }

  #cancel(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(sessionId);
  }
}
