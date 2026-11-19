// Scroll following for the transcript (architecture section 8.4), as a state machine with no DOM
// access so it can be tested on its own. The view feeds it scroll events, user input and size
// changes and applies the pins it asks for.
//
// Interaction model: while following, growth of the content pins the viewport to the bottom
// with no animation. Wheel, touch, keyboard and scrollbar input mark the next
// `userInputWindowMs` as the user's: pins are held back in that window, and a scroll that moves
// up beyond `releasePx` from the bottom stops following; a user scroll down to within
// `resumePx` resumes it. Scrolls without recent user input (pins, layout changes) never change
// the mode. The cooldown window and the release/resume/button distances follow the interaction
// notes of open-claude-ui (MIT, github.com/Caho1/open-claude-ui, code-examples/
// useClaudeScrollPinning.ts at be395eb); the implementation here is PiArc's own.
import { SCROLL_FOLLOW, type ScrollFollowThresholds } from './constants.js';

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** What the view shows; changes are reported to subscribers. */
export interface FollowView {
  readonly following: boolean;
  /** The "back to bottom" button is visible. */
  readonly showButton: boolean;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export class ScrollFollow {
  private view: FollowView = { following: true, showButton: false };
  private lastScrollTop: number | null = null;
  private lastUserInputAt = Number.NEGATIVE_INFINITY;
  private pointerHeld = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly thresholds: ScrollFollowThresholds = SCROLL_FOLLOW) {}

  get state(): FollowView {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Wheel, touch or keyboard input that scrolls. Pins are held back until the scroll it causes
   * has arrived, so growth cannot pull the viewport down under the user.
   */
  userInput(now: number): void {
    this.lastUserInputAt = now;
  }

  /** A pointer went down on the scrollbar, or a pointer went up anywhere. Only a release of
   * the scrollbar is scroll input: a click elsewhere (a card's button) must not hold back the
   * pins its result needs. */
  pointer(now: number, held: boolean): void {
    if (held || this.pointerHeld) this.lastUserInputAt = now;
    this.pointerHeld = held;
  }

  /**
   * Handles a scroll event. Returns `true` when the view should pin to the bottom: following,
   * not at the bottom, and no user input in progress.
   */
  scrolled(metrics: ScrollMetrics, now: number): boolean {
    const distance = distanceFromBottom(metrics);
    const delta = this.lastScrollTop === null ? 0 : metrics.scrollTop - this.lastScrollTop;
    this.lastScrollTop = metrics.scrollTop;
    let following = this.view.following;
    if (this.isUserActive(now)) {
      if (delta < 0 && distance > this.thresholds.releasePx) {
        following = false;
      } else if (delta >= 0 && distance <= this.thresholds.resumePx) {
        following = true;
      }
    }
    this.update({ following, showButton: distance > this.thresholds.buttonPx });
    return following && distance > 0 && !this.isUserActive(now);
  }

  /**
   * The content or the viewport changed size. Returns `true` when the view should pin to the
   * bottom now.
   */
  resized(metrics: ScrollMetrics, now: number): boolean {
    const distance = distanceFromBottom(metrics);
    const pin = this.view.following && distance > 0 && !this.isUserActive(now);
    this.update({
      following: this.view.following,
      showButton: !pin && distance > this.thresholds.buttonPx,
    });
    return pin;
  }

  /** The view pinned itself to the bottom. */
  pinned(metrics: ScrollMetrics): void {
    this.lastScrollTop = metrics.scrollTop;
    this.update({ following: this.view.following, showButton: false });
  }

  /** "Back to bottom": follow again; the view scrolls to the bottom. */
  jumpToBottom(): void {
    this.lastUserInputAt = Number.NEGATIVE_INFINITY;
    this.update({ following: true, showButton: false });
  }

  private isUserActive(now: number): boolean {
    return this.pointerHeld || now - this.lastUserInputAt <= this.thresholds.userInputWindowMs;
  }

  private update(next: FollowView): void {
    if (next.following === this.view.following && next.showButton === this.view.showButton) {
      return;
    }
    this.view = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
