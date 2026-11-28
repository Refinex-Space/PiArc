// When the first-run guide opens by itself (ADR-0110). The preference already folds in a
// configured provider or a signed-in account (`preferencesFrom`); a known workspace marks a
// user from before the guide too, and a window started for a link or a dropped folder goes
// where it was asked to.
export type AutoShow = 'wait' | 'show' | 'hide';

export function autoShow(input: {
  readonly completed: boolean;
  /** Whether the first `core/workspaces` snapshot arrived. */
  readonly workspacesKnown: boolean;
  readonly workspaces: number;
  /** A launch target arrived for this window since it started. */
  readonly launched: boolean;
}): AutoShow {
  if (input.completed || input.launched) return 'hide';
  if (!input.workspacesKnown) return 'wait';
  return input.workspaces === 0 ? 'show' : 'hide';
}
