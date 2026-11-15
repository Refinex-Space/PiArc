import { describe, expect, it } from 'vitest';

import { SCROLL_FOLLOW } from './constants.js';
import { ScrollFollow, distanceFromBottom, type ScrollMetrics } from './scroll-follow.js';

const VIEWPORT = 600;

function at(scrollTop: number, scrollHeight = 5_000): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight: VIEWPORT };
}

const bottom = (scrollHeight = 5_000): number => scrollHeight - VIEWPORT;

describe('ScrollFollow', () => {
  it('starts following and pins when content grows', () => {
    const follow = new ScrollFollow();
    expect(follow.state.following).toBe(true);
    follow.scrolled(at(bottom()), 0);
    expect(follow.resized(at(bottom(), 5_100), 1_000)).toBe(true);
  });

  it('stops following when the user scrolls up beyond the release distance', () => {
    const follow = new ScrollFollow();
    follow.scrolled(at(bottom()), 0);
    follow.userInput(1_000);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.releasePx), 1_010);
    expect(follow.state.following).toBe(true);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.releasePx - 1), 1_020);
    expect(follow.state.following).toBe(false);
    expect(follow.resized(at(bottom() - 3, 5_200), 2_000)).toBe(false);
  });

  it('holds pins back while the user is scrolling', () => {
    const follow = new ScrollFollow();
    follow.scrolled(at(bottom()), 0);
    follow.userInput(1_000);
    expect(follow.resized(at(bottom(), 5_100), 1_000 + SCROLL_FOLLOW.userInputWindowMs)).toBe(
      false,
    );
    expect(follow.resized(at(bottom(), 5_100), 1_001 + SCROLL_FOLLOW.userInputWindowMs)).toBe(true);
  });

  it('resumes when the user scrolls back down within the resume distance', () => {
    const follow = new ScrollFollow();
    follow.scrolled(at(bottom()), 0);
    follow.userInput(1_000);
    follow.scrolled(at(bottom() - 500), 1_010);
    expect(follow.state.following).toBe(false);
    follow.userInput(2_000);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.resumePx - 1), 2_010);
    expect(follow.state.following).toBe(false);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.resumePx), 2_020);
    expect(follow.state.following).toBe(true);
  });

  it('ignores scrolls that are not the user, such as layout shifts', () => {
    const follow = new ScrollFollow();
    follow.scrolled(at(bottom()), 0);
    expect(follow.scrolled(at(bottom() - 300), 5_000)).toBe(true);
    expect(follow.state.following).toBe(true);
    follow.userInput(6_000);
    follow.scrolled(at(bottom() - 1_000), 6_010);
    expect(follow.state.following).toBe(false);
    follow.scrolled(at(bottom()), 9_000);
    expect(follow.state.following).toBe(false);
  });

  it('treats scrolls while a pointer holds the scrollbar as the user', () => {
    const follow = new ScrollFollow();
    follow.scrolled(at(bottom()), 0);
    follow.pointer(1_000, true);
    follow.scrolled(at(bottom() - 100), 5_000);
    expect(follow.state.following).toBe(false);
    follow.pointer(5_100, false);
  });

  it('shows the button beyond the button distance and hides it after a jump', () => {
    const follow = new ScrollFollow();
    const seen: boolean[] = [];
    follow.subscribe(() => seen.push(follow.state.showButton));
    follow.scrolled(at(bottom()), 0);
    follow.userInput(1_000);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.buttonPx), 1_010);
    expect(follow.state.showButton).toBe(false);
    follow.scrolled(at(bottom() - SCROLL_FOLLOW.buttonPx - 1), 1_020);
    expect(follow.state.showButton).toBe(true);
    follow.jumpToBottom();
    expect(follow.state).toEqual({ following: true, showButton: false });
    expect(seen).toEqual([false, true, false]);
  });
});

describe('distanceFromBottom', () => {
  it('never goes negative', () => {
    expect(distanceFromBottom({ scrollTop: 10, scrollHeight: 100, clientHeight: 200 })).toBe(0);
  });
});
