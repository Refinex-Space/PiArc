// Background throttling of browser pages (design addendum B5.6, chapter 11's memory and idle
// CPU budgets): a hidden page's timers and frames are throttled like a background tab in
// Chrome, except the pages of an agent Space while its `Browser` call runs, whose scripts wait
// on timers and animations the user does not see.

/** The part of a Space that decides it. */
export interface ThrottledSpace {
  readonly kind: 'user' | 'agent';
  readonly running: boolean;
}

/** Whether pages of `space` are throttled while hidden. */
export function throttledWhenHidden(space: ThrottledSpace | undefined): boolean {
  return !(space?.kind === 'agent' && space.running);
}

/** Applies the rule to each tab's page: `set` is `webContents.setBackgroundThrottling`. */
export function applyThrottling<T extends { readonly space: string }>(
  tabs: readonly T[],
  spaces: readonly (ThrottledSpace & { readonly id: string })[],
  set: (tab: T, throttled: boolean) => void,
): void {
  for (const tab of tabs) {
    set(tab, throttledWhenHidden(spaces.find((space) => space.id === tab.space)));
  }
}
